// 协议名在运行时拼装：源码里不出现明文，混淆后也不会残留（`tools/check-obf.js` 会查残留）。

// 协议名在运行时拼装，源码里不出现明文，混淆后也不会残留
export const P_V = String.fromCharCode(118, 108, 101, 115, 115); // 118 108 101 115 115
export const P_T = String.fromCharCode(116, 114, 111, 106, 97, 110); // 116 114 111 106 97 110
