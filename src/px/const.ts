/* 中转域共享常量：pool / seed / selector 共用，单独一层避免互相 import */

export const SEED_KEY = "px:seed";
export const SEED_READ_MS = 30 * 60000; // 信誉表回读周期（注意与 SC.SEED_TTL「先验保质期」不是一回事）
export const SEED_MAX = 800; // 每个机房最多记 800 个节点（110 B/节点，KV 单值约 88 KB）
export const PX_TTL = 86400 * 30;
export const SEED_VER = 6;
export const MODES: Mode[] = ["lat", "tput"];
export const keyOf = (x: NodeEntry) => x.h + ":" + x.p;
