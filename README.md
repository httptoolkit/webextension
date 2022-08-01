# HTTP Toolkit WebExtension [![Build Status](https://github.com/httptoolkit/webextension/workflows/CI/badge.svg)](https://github.com/httptoolkit/webextension/actions)

> _Part of [HTTP Toolkit](https://httptoolkit.tech): powerful tools for building, testing & debugging HTTP(S)_

A browser extension used in HTTP Toolkit to intercept non-HTTP browser requests (specifically: hooking WebRTC to mock it automatically with [MockRTC](https://github.com/httptoolkit/mockrtc)).

Right now this is not useful standalone - only when combined with HTTP Toolkit for setup. In future it may be usable for automated RTC testing (but not today). Instead, it's best to use MockRTC directly, and use the `MockRTC.hookWebRTCConnection(conn, peer)` or `MockRTC.hookAllWebRTC()` hooks when testing.

---

_This‌ ‌project‌ ‌has‌ ‌received‌ ‌funding‌ ‌from‌ ‌the‌ ‌European‌ ‌Union’s‌ ‌Horizon‌ ‌2020‌‌ research‌ ‌and‌ ‌innovation‌ ‌programme‌ ‌within‌ ‌the‌ ‌framework‌ ‌of‌ ‌the‌ ‌NGI-POINTER‌‌ Project‌ ‌funded‌ ‌under‌ ‌grant‌ ‌agreement‌ ‌No‌ 871528._

![The NGI logo and EU flag](./ngi-eu-footer.png)