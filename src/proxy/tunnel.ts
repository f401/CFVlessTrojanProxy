import type { Socket } from "cloudflare:sockets";
import { FIRST_BYTE_MS, WS_OPEN, closeQuietly, errMsg, safeSend, toU8 } from "../core/util";
import { logErr, rttMark } from "../nodes/metrics";
import { nsDecay, NodeStatsTable } from "../nodes/score";
import { cnt } from "../core/counter";
import { PEND, pendAdd } from "../store/pend";
import { S } from "../core/state";
import type { Connection } from "./connection";

/**
 * 功能：把上游数据流写回 WS（下游方向），流结束或出错时收尾。
 * @param ws 客户端 WS
 * @param reader 上游数据流
 * @returns 无
 */
export function pipeBack(
  sock: Socket,
  ws: WebSocketLike,
  st: Connection,
  onClose?: (gotData: boolean) => void | Promise<void>,
  firstByteMs: number = FIRST_BYTE_MS,
): void {
  // 首字节看门狗：黑洞出口会「连上但一个下游字节都不给」，pipeTo 的流一直挂着，
  // close/error 永不触发 ⇒ 补救链（换中继/直连兜底）不启动，客户端干等到 30s 定时器。
  // 10s 无下行就主动关 socket，让 close/catch 走 onClose(false) 启动补救。
  // firstByteMs 可注入，测试用极短值模拟；正常连接收到首字节或流结束立即撤销。
  let wd: ReturnType<typeof setTimeout> | null = null;
  let wdFired = false; // 本 hop 局部变量：递归重试挂新 socket 时会开新的 pipeBack 闭包，互不干扰
  const clearWd = (): void => {
    if (wd !== null) {
      clearTimeout(wd);
      wd = null;
    }
  };
  const armWd = (): void => {
    // 不看 notified：换路后 notified 仍是上一跳设的 true，但新 hop 仍需要看门狗。
    // 流一旦结束 close() 会 clearWd，所以正常收尾不会与看门狗竞态。
    if (!onClose || st.down > 0 || wdFired) return;
    const elapsed = st.tAttach ? Date.now() - st.tAttach : 0;
    wd = setTimeout(() => {
      wd = null;
      if (st.down > 0 || wdFired) return;
      wdFired = true;
      cnt("fbwd");
      // 关 socket 让 pipeTo 立即 settle：close()/catch() 会带着 down===0 走到 onClose(false)
      closeQuietly(sock);
    }, Math.max(0, firstByteMs - elapsed));
  };
  armWd();

  sock.readable
    .pipeTo(
      new WritableStream({
        async write(chunk) {
          const u8 = toU8(chunk);
          // 热路径：加字节 → 比阈值 → 发送。其余全在 tick 里（每 512 KB）
          st.down += u8.length;
          if (st.down > 0) clearWd(); // 首字节到了：链路不是黑洞，撤销看门狗
          if (!st.ttfb && st.tAttach) st.ttfb = Date.now() - st.tAttach;
          if (st.down >= st.mark) {
            if (!(await st.tick(ws))) return;
          }
          if (st.header && !st.headerSent) {
            const merged = new Uint8Array(st.header.length + u8.length);
            merged.set(st.header, 0);
            merged.set(u8, st.header.length);
            // 发不出去就是客户端已经走了：立刻抛错让 pipeTo 收尾，
            // 别继续从上游搬数据（那是纯浪费，还会掩盖真实断点）
            if (!safeSend(ws, merged)) throw new Error("client gone");
            st.headerSent = true;
          } else if (!safeSend(ws, u8)) {
            throw new Error("client gone");
          }
          if (!st.markedOk) {
            st.markedOk = true;
            rttMark(st.id, st.ipTag, true);
          }
        },
        close() {
          clearWd(); // 流已结束：看门狗不再需要
          if (onClose && !st.notified) {
            // 只通知一次：pipe 的 error 路径也会走到同一个 onClose（见下面的 catch）
            st.notified = true;
            // onClose 是 async（可能再拨号 / attach）：这里必须接住 rejection，
            // 否则会在事件回调里变成 unhandled rejection，Workers 直接记 1101。
            try {
              Promise.resolve(onClose(st.down > 0)).catch((e) => {
                logErr("pipe close: " + errMsg(e), st.node || "");
              });
            } catch (e) {
              logErr("pipe close: " + errMsg(e), st.node || "");
            }
          } else {
            try {
              ws.close(1000, "done");
            } catch (e) {}
          }
        },
        abort() {
          closeQuietly(sock);
        },
      }),
    )
    .catch(async (err) => {
      // 每条异常收尾都留一条「搬到多少 / 多久 / WS 状态 / 是否已通知」的证据，并立刻推 DO：
      // 大文件断流到底是边缘或客户端先走（这条能落盘）还是 isolate 被资源限额杀掉
      // （catch 根本不执行 ⇒ 这条不会出现），只有这两者之差能区分。
      const endMs = st && st.tAttach ? Date.now() - st.tAttach : 0;
      logErr(
        `dl end ${st ? st.down : 0}B/${endMs}ms rs=${ws ? ws.readyState : -1} n=${st && st.notified ? 1 : 0} e=${errMsg(err)}`,
        st && st.node ? st.node : "",
      );
      // 直接 await 一次强制上报，而不是 kickFlush：kick 走 setTimeout(0)，
      // 客户端已经走了以后这个 isolate 很可能等不到定时器就被回收，证据永远进不了 DO。
      // 而且必须先往账本登记一行 —— flush 的入口是「账本为空就早退」，
      // 没有这行 pending，错误环根本不会被拼进请求体（body.e）。
      if (st && st.env && st.id) {
        pendAdd(st.id, 0, 0);
        const push = (async () => {
          await PEND.flush(st.env, true, 1).catch(() => {});
          // 单飞期间这次会直接返回（只记 forceSkipped，补排又是 setTimeout）：
          // 再补一次，确保这一行真的发出去了。
          if (S.pend.size) await PEND.flush(st.env, true, 1).catch(() => {});
        })();
        // 还要挂 waitUntil：客户端断开后这次请求随时可能结束，裸 await 拿不到执行机会
        // （7.420 线上 3 次 terminate 对照仍然 0 条记录，就是这一步缺的）。
        try {
          st.ctx.waitUntil(push);
        } catch (e) {
          await push;
        }
      }
      closeQuietly(sock);
      const clientGone = !ws || ws.readyState !== WS_OPEN;
      if (st && !st.notified) {
        if (clientGone) {
          // 客户端自己走了（切网 / 关标签 / 取消）：不是节点的问题，不记失败、不冻结。
          // 但必须留下「走到多少字节、跑了多久」的证据：大文件断流到底是边缘丢连接
          // 还是 isolate 被资源限额杀掉，只有这条记录能区分（后者连 catch 都不执行）。
          st.notified = true;
          cnt("ccut");
          const goneMs = st.tAttach ? Date.now() - st.tAttach : 0;
          logErr(`client gone ${st.down}B/${goneMs}ms`, st.node || "");
          // 立刻推一次 DO：isolate 被回收时内存里的错误环会一起消失，只有落盘的才算证据
          if (st.env && st.id) {
            pendAdd(st.id, 0, 0);
            const push = (async () => {
              await PEND.flush(st.env, true, 1).catch(() => {});
              if (S.pend.size) await PEND.flush(st.env, true, 1).catch(() => {});
            })();
            try {
              st.ctx.waitUntil(push);
            } catch (e) {
              await push;
            }
          }
        } else if (st.down === 0 && onClose) {
          // 连上了却一个下行字节都没给就报错：与「上游正常关闭、零字节」（close 路径）
          // 是同一种可观察事实，必须走同一本账 —— attacher 的 onClose 会记 eCloseP、
          // 给 nsEmptyClose 降权、并换一条中继重试。7.245 之前这里什么都不做，于是
          // 「接受连接后立刻 RST」的节点既不计数也不降权，客户端只收到 1011。
          st.notified = true;
          Promise.resolve(onClose(false)).catch((e) => {
            logErr("pipe close: " + errMsg(e), st.node || "");
          });
        } else if (st.down > 0) {
          st.notified = true;
          st.failed = true;
          cnt("cut");
          if (st.node) {
            if (st.siteFail) {
              NodeStatsTable.nsSiteFail(st.node); // 站点侧：只轻记
            } else {
              // 中途断流是节点问题：只记 trafficFailW 的话 pFail/可用性完全看不到，
              // 节点过了 60 秒冻结又原样回到候选表。加 0.5 次失败权重（不走阶梯）。
              const sn = NodeStatsTable.nsGet(st.node),
                now = Date.now();
              nsDecay(sn, now);
              sn.failW = (sn.failW || 0) + 0.5;
              sn.fail = (sn.fail || 0) + 0.5;
              sn.trafficFailW = (sn.trafficFailW || 0) + 0.5;
              // 中途断流的节点先凉 60 秒；站点级试探不冻结（可能只是对这个站不行）
              if (!st.hostTrial) {
                sn.freeUntil = Math.max(sn.freeUntil || 0, now + 60000);
                S.hostRankCache.clear(); // 站点排行不能继续推荐刚断流的节点
                NodeStatsTable.invalidateRank();
              }
              sn.at = now;
            }
          }
        }
      }
      // 看门狗触发的黑洞：onClose(false) 已启动补救链，它会递归接新 socket 并复用同一个
      // clientSocket；此时若关掉客户端 WS，换到的新链路就无处回传，补救全白做。
      // 非看门狗场景保持原行为（真正的 pipe error 才关客户端）。
      if (!clientGone && !wdFired) {
        try {
          ws.close(1011, "pipe error");
        } catch (e) {}
      }
    });
}

