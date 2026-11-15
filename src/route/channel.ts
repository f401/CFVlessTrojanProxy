// 通道模型：一次请求只有两种通道 —— 直连、中继（IP）。
// 键统一为 `d` / `r:<ip>`，判定表与选路都用它做键。
// 第三类「入口」（`e:<ip>`）在 v6 时代存在过：当时想比「客户端→边缘」的入口质量，但 Worker 访问
// 自家域名必然 522 自环（硬约束 4），探测链 7.69 删空、入口偏好表 7.133 整条删除。此后 `e:` 既没有
// 写入者也没有读者，留着它只会让「看起来有人写」的键空间继续骗人，所以连带类型一起去掉。

export type ChanKind = "d" | "r";

export interface Chan {
  kind: ChanKind;
  ip: string;
}

export const DIRECT: Chan = { kind: "d", ip: "" };

/**
 * 功能：把通道对象转成判定表用的键。
 * @param c 通道
 * @returns 直连为 d，中继为 r:ip
 */
export function chanKey(c: Chan): string {
  return c.kind === "d" ? "d" : c.kind + ":" + c.ip;
}

/**
 * 功能：中继通道的节点键（池子统计用 `host:port`），直连返回空串。
 * @param c 通道
 * @returns 中继为 ip:443，直连为空串
 */
export function nodeKeyOf(c: Chan): string {
  return c.kind === "r" ? c.ip + ":443" : "";
}
