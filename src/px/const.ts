/* 中转域共享常量：pool / seed / selector 共用，单独一层避免互相 import */

export const SEED_KEY = "px:seed";
export const SEED_TTL = 30 * 60000; // 信誉表回读周期
export const SEED_MAX = 40; // 每个机房最多记 40 个节点
export const PX_TTL = 86400 * 30;
export const SEED_VER = 6;
export const MODES: Mode[] = ["lat", "tput"];
export const keyOf = (x: NodeEntry) => x.h + ":" + x.p;
