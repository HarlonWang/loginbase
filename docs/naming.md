# 命名记录：为什么叫 loginbase

> 2026-08-10 定名。记录标准、各轮候选与死名单，避免将来再绕回查过的名字。

## 命名标准

1. 语义贴合「登录 + 注册」入口层——**不越界到 user 体系**（用户档案/权益在各 App 业务侧，见 design.md 的边界节）
2. 避开知名占用（auth 词族的命名空间极度拥挤）
3. 作 GitHub 仓库名 / npm 包名 / Maven 坐标 / Kotlin 包名都顺
4. 功能直述，不要文化梗和隐喻

## 各轮讨论与死名单

**第一轮（隐喻向，方向被否）**：signet（AI-agent 身份圈扎堆 + Google Ruby OAuth 库）、gatehouse（Rust 授权库 + 卫报 Identity API）、hufu/虎符、tessera（Ciphera 零知识身份 SDK + tesseral）。结论：要功能直述，本轮全弃。

**第二轮（-kit 族）**：auth-kit（WorkOS AuthKit）、passkit（Apple）、account-kit（Meta 旧产品 + Alchemy 现役）、identity-kit / idkit（NFID、Worldcoin）、login-kit（Snapchat 官方 Login Kit）、userkit（可用但语义越界到 user）。结论：kit 后缀不必须。

**第三轮（-d 守护进程族）**：userd（干净但语义越界）、authd（Canonical）、logind（systemd-logind）。结论：范围钉回 login。

**第四轮（login/auth 直述词）**：authn（Keratin AuthN——名字和形态双撞：Go 服务端 + 多语言客户端）、passwordless（Bitwarden）、passport（passport.js）、userbase / userstack / userflow / usergate / userhub / authgate / uauth / onelogin / unilogin / authcore（全有占用）、login 裸词（可用但太素）。

**第五轮（login 组合词）**：
- loginbox：仅休眠 PHP SDK + 死 npm 包，具象好记，但 UI 联想偏强（库主体无 UI）
- logincore：零占用，素
- loginflow：被 React demo 群稀释
- 语言层面自毙：logingate（"-gate" 是丑闻后缀）、loginforge/authforge（forge 兼「伪造」义）、loginloop（登录死循环）、loginpass（authlib 作者已占）

## 定名：loginbase

- **后缀有家谱**：-base 是后端底座的既定词缀（Firebase / Supabase / PocketBase），loginbase 自动获得「登录这件事的共用底座」联想，恰合「抽出来给多个 App 统一使用」的定位
- **范围不越界**：base 只承诺登录的地基，不承诺 user 体系
- **完全无占用**：GitHub / npm 连同名玩具项目都没有（2026-08-10 查证）

## 连写，不加连字符

1. -base 家族全是连写（没有 Fire-base）；连写是品牌名，带杠是描述短语
2. 硬约束：Kotlin/Java 包名不允许连字符，包名只能是 `wang.harlon.loginbase`——仓库/npm 若带杠会与包名永久错位
3. 唯一的杠是 `-kt` 产物后缀（`loginbase-kt`），那是区分语言产物的行业惯例（kotlinx-coroutines-core 一脉），与词内分割无关

```
仓库        HarlonWang/loginbase
npm         loginbase
Maven       wang.harlon:loginbase-kt
Kotlin 包    wang.harlon.loginbase
类名前缀     Loginbase（如 LoginbaseClient）
```

> Maven 坐标 2026-08-10 修订：原定 `wang.harlon.loginbase:loginbase-kt` 是 R2 自建仓时代的写法；改发 Maven Central 后对齐 kmp-webview 惯例（`wang.harlon:kmp-webview`），group 用已验证的裸 namespace，避免 group 末尾与 artifact 前缀重复。Kotlin 包名不变，仍是 `wang.harlon.loginbase`（Maven group 与 Kotlin 包名本就不要求一致，kmp-webview 即先例）。

> npm 坐标 2026-08-12 修订：原定 `@harlonwang/loginbase`，但 npm 账号用户名是 `whlong`、无 `harlonwang` org，scope 当前不可发；权衡「建 org 保 scope / 裸名 / @whlong」后定为**裸名 `loginbase`**——定名时已查证 npm 无占用（本文上节），裸名与仓库名完全一致且最短；代价是放弃 scope 命名空间，接受为独立品牌名。@whlong 因与 GitHub/Maven 命名体系割裂被弃。
