/* 中转域共享常量：pool / seed / selector 共用，单独一层避免互相 import */

export const SEED_KEY = "px:seed";
export const SEED_READ_MS = 30 * 60000; // 信誉表回读周期（v7 起 seed 只存名字，没有「先验保质期」这回事了）
export const SEED_MAX = 800; // 每个机房最多记 800 个节点（现在只存名字 k/h/p/cc，约 30 B/节点）
export const PX_TTL = 86400 * 30;
// v7：信誉表降级成"候选名单"（不再存 ms/tcp/tls/n/f/b/sb/hp）——
// 每个 isolate 的最优节点可能完全不同，跨 isolate 的品质结论只会把冷启动带偏
export const SEED_VER = 7;
export const MODES: Mode[] = ["lat", "tput"];
export const keyOf = (x: NodeEntry) => x.h + ":" + x.p;

