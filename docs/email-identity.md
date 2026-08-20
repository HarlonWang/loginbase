# 邮箱与身份锚点 —— 接入方必读

> 本库把 GitHub 的邮箱信息原样交给接入方（`onVerified` / `onLinked` 的 `email` 与
> `verifiedEmails`），**「怎么找号、怎么建号」全部由接入方决定**。这份文档解释那两个字段
> 各自是什么、从哪来、以及拿它们做账号锚点时有哪些已知的坑。
>
> 每条结论标注依据：**【官方】**GitHub / OpenID 官方文档 · **【实测】**真实 API 调用（2026-08-20）。

---

## 1. GitHub 有几种「邮箱」

**【官方】** `docs.github.com/en/account-and-profile/concepts/email-addresses`、
`.../reference/email-addresses-reference`：

| 类型 | 含义 | 数量 |
|---|---|---|
| **primary** | 账号主邮箱，不能与 backup 相同 | 1 |
| **backup** | 备用邮箱 | 0–1 |
| 其余已添加邮箱 | 「GitHub 允许你添加任意多个邮箱」 | 任意 |
| **verified / unverified** | 每个邮箱独立的验证状态。**未验证则无法授权 OAuth 应用** | — |
| **commit email** | 关联提交用，可与 primary 不同，命令行与网页端可分别设置 | — |
| **noreply** | `ID+USERNAME@users.noreply.github.com`（2017-07-18 后注册的账号）。**收不到信** | 1 |
| **visibility** | **仅针对 primary**，`public` / `private`，由 `PATCH /user/email/visibility` 设置 | — |

**要点：「是 primary」与「对外公开」是两个正交维度**——primary 完全可以是 private 的。

**一个用户手上通常有多个已验证邮箱。** 这是本文所有问题的根源。

## 2. 四个端点返回的不是同一个东西

| 端点 | 需要 `user:email`？ | 返回 |
|---|---|---|
| `GET /user` | **不需要** | 单个 `email` 字段 |
| `GET /user/emails` | **需要** | 全部邮箱 + `primary` / `verified` / `visibility` |
| `GET /user/public_emails` | 需要（纯公开资源可免认证） | 仅公开可见的那个 |
| `GET /users/{username}` | 免认证 | 公开档案，`email` 为公开邮箱或 null |

### 实测证据（2026-08-20）

| 调用 | token | 结果 |
|---|---|---|
| `GET /user/emails` | scope 无 `user:email` | **404**，提示 needs "user" scope |
| `GET /user` | 同上 | `email` **有值** |
| `GET /users/{name}` | 匿名 | `email` = **null** |
| `GET /user` | OAuth，**有** `user:email` | 两个真实登录样本 → 均为 **null** |

**结论：`GET /user` 的 `email` 与 scope 无关，且经常是 null——不要依赖它。**

最后一行是最有力的：两个样本明明持有 `user:email` scope，`GET /user` 照样给 null，
而同一次登录里 `GET /user/emails` 返回了他们的真实邮箱。

⚠ **未完全确认**：`GET /user` 的 `email` 究竟取「公开档案邮箱」还是「primary（除非用户开了
Keep my email address private）」。实测数据与两种解释都相容。不影响本库任何行为——
本库不使用该字段做身份判断。

### 这解释了一类历史欠账

若 OAuth scope 不含 `user:email`，就**够不着 `/user/emails`**，只能读 `GET /user` 那个常为 null
的字段。结果是一批用户在系统里「有 GitHub 身份、却没有邮箱」。若接入方的邮箱登录以
`email` 为锚点，这批人**用任何邮箱都登不回原账号**。

本库的默认 scope 含 `user:email`，正是为避免这个坑。

## 3. 本库交给接入方的是什么

**【代码】** `src/plugins/github.ts`：

```
verifiedEmails  = /user/emails 中所有 verified 的，trim + 小写归一化   ← 数组，全部
email           = primary 且 verified 优先，否则任一 verified          ← 单个，便利值
providerProfile = GET /user 经白名单裁剪（其中的 email 字段常为 null，见 §2）
```

**`email` 只是 `verifiedEmails` 的一个便利摘要，不是「用户的邮箱」。**
一个用户可能有 3 个已验证邮箱，`email` 只告诉你其中一个。

这一点的**权威说明在类型定义上**，`src/config.ts` 的 `VerifiedIdentity.verifiedEmails`
（1.2.0 起）写得很清楚：

> App 可用整个列表做账号对账——GitHub 上挂了多个验证邮箱、其中之一才是 App 账号邮箱的用户，
> **只比对 `email` 会被误判为新人**。

写接入代码时 IDE 悬停就能看到，比翻本文档更早一步。**本文档是那句话的展开，不是它的替代。**

⚠️ 现实提醒：这条警告位置对、措辞准、时间也早（1.2.0），但第一个接入方仍然写出了
`const { email } = identity` 把数组丢掉。**写对注释不等于有人照做**——设计钩子签名时，
与其指望调用方读注释，不如考虑让易错用法更难写出来。

`onLinked`（绑定已登录账号）路径下 **`email` 可以缺省**：那条路径的身份由 `userId` 决定，
邮箱只是附加信息。`onVerified`（登录/注册）则不同，邮箱可能是接入方唯一的找号线索。

## 4. 为什么不该拿邮箱当账号锚点

### 4.1 先说清适用性：GitHub 登录不是 OIDC

**【实测】** `github.com/.well-known/openid-configuration` 与
`api.github.com/.well-known/openid-configuration` 均返回 **404**；只有
`token.actions.githubusercontent.com/.well-known/openid-configuration` 返回 200，
但那是 **GitHub Actions 的** OIDC（供云厂商联合身份用），与用户登录无关。

**GitHub 的用户登录 OAuth App 不签 ID Token，没有 `iss` / `sub` claim。**
因此下面引用的 OIDC 条文对这条链路**不具规范约束力**——引用它是因为它把道理讲清楚了，
不是因为「违反了它」。

### 4.2 OIDC Core §5.7 讲的道理

**【官方】** OpenID Connect Core 1.0 §5.7 Claim Stability and Uniqueness：

> The `sub` and `iss` Claims ... are the only Claims that an RP can rely upon as a stable
> identifier for the End-User ... an Issuer **MAY re-use an email Claim Value across different
> End-Users at different points in time**, and the claimed email address for a given End-User
> **MAY change over time**. Therefore, other Claims such as `email` ... **MUST NOT** be used as
> unique identifiers for the End-User.

两条理由对 GitHub 同样成立：

- **邮箱会易主**——用户可以从 GitHub 删除一个已验证邮箱，此后他人可验证并占用它
- **邮箱会变**——随时可增删改

### 4.3 稳定的锚点是 `providerUserId`

GitHub 的数字用户 ID 稳定、唯一、不重分配（改用户名也不变），是 `iss + sub` 的等价物。

**接入方应以 `providerUserId` 为主锚点，邮箱最多作为兜底。**

### 4.4 若确实要用邮箱兜底，先算清自己的实际风险

不要照搬结论，回到自己系统的配置去算。一个典型推演：

> 要让「邮箱兜底」把攻击者的 GitHub 并入受害者账号，攻击者必须让 GitHub 返回受害者的邮箱 X。
> 本库只取 `verified: true` 的邮箱，所以他必须真的收到 GitHub 发往 X 的验证信——即他控制了 X。
> 但若他已控制 X，而接入方的邮箱登录是**验证码**登录，他直接走验证码就进去了。
> **此时邮箱兜底与邮箱验证码登录风险等价，未引入额外攻击面。**

⚠ **这个等价关系依赖前提**：邮箱登录必须是验证码式的，且只接受 verified 邮箱。
若接入方支持密码登录、或接受未验证邮箱，等价关系立刻断裂，邮箱兜底会成为真正的额外攻击面。
**把这个前提写进代码注释**，免得日后加了密码登录却没人想起来。

## 5. 业界怎么处理（2026-08-20 查证）

| 模式 | 代表 | 做法 | 代价 |
|---|---|---|---|
| **A 全分开，永不自动合并** | **Auth0**（默认） | 「treats all identities as separate by default」。只提供 user-initiated 与 suggested linking，且**关联前必须对两个账号都完成认证**，手动关联还要求重新输凭据 | 最安全；用户须自己发起，体验最差 |
| **B 按 verified email 自动关联 + IdP 信任分级** | **Firebase**、**Clerk** | 见 5.1 / 5.2 | 体验最好；必须做信任分级 |
| **C 一个账号挂多个邮箱** | **Clerk**、**GitHub 自己** | 用户可在个人页添加多个邮箱，此后匹配任一邮箱的 OAuth 账号都归到同一账号 | 根治「用户有多个邮箱」；schema 与唯一性约束要重做 |

### 5.1 Firebase 的 IdP 信任分级

**【官方】** 判据是「**若 IdP 只验证一次邮箱、却允许用户此后改邮箱而不重新验证，则不可信**」：

- **可信**：Google（仅 @gmail.com）、Yahoo（仅 @yahoo.com）、Microsoft（仅 @outlook/@hotmail）、Apple
- **不可信**：Facebook、Twitter、**GitHub**、上述几家在非自有域名下的邮箱、未验证的邮箱密码

同一邮箱的自动关联规则：

| 先 → 后 | 结果 |
|---|---|
| 不可信 → 不可信 | ❌ 抛错，要求账号关联 |
| 可信 → 不可信 | ❌ 抛错 |
| 不可信 → 可信 | ✅ 可信方覆盖 |
| 可信 → 可信 | ✅ 自动关联 |

它给的攻击场景：用户用 @gmail.com 登 Google，攻击者用同一个 @gmail.com 在 Facebook 建号；
若自动关联，攻击者即取得该账号。

**对本库要打折**：Firebase 判 GitHub 不可信，但本库只取 `verified: true` 的邮箱，
比该场景严格（详见 §4.4 的推演）。

### 5.2 Clerk 对「两边邮箱不同」的答案

**【官方】** Clerk 以 email 为公共标识自动关联：

| 情况 | 处理 |
|---|---|
| OAuth 与 Clerk 两侧邮箱**都已验证** | ✅ 直接关联并登录，连密码校验都跳过 |
| Clerk 侧已验证、OAuth 侧未验证 | 先发起验证，通过后关联 |
| Clerk 侧未验证 | ⚠ 防接管措施：先验证邮箱，可能还要求改密码或校验既有连接 |
| **两边邮箱根本不同** | **让用户在个人页里把另一个邮箱加进来**；此后两个邮箱各自关联的 OAuth 账号都归到同一账号 |

最后一行是「用户有多个邮箱」这个问题的业界标准答案：**不是把匹配逻辑做得更聪明，
而是让账号能容纳多个邮箱。**

## 6. 给接入方的落地建议

1. **主锚点用 `providerUserId`**，不要用邮箱。这是唯一稳定的标识。
2. **`verifiedEmails` 是数组，别只用 `email`。** 只比 primary 会漏掉用户在 GitHub 上的其他
   已验证邮箱，导致同一个人被判为新用户。
3. **若用邮箱兜底，先想清楚多候选命中不同账号怎么办**——遍历 `verifiedEmails` 时，邮箱 X 可能
   命中 A 号、邮箱 Y 命中 B 号。必须预先定规则（取最早？拒绝并让用户选？），不能默认取第一个。
4. **考虑让账号能挂多个邮箱**（模式 C）。若你的系统只记一个邮箱，用户换个自己的邮箱登录就会
   建出新账号，而他会认为「账号丢了」。
5. **绑定冲突要给出路。** 若你的实现是「该第三方身份已属他人即拒绝」（这是对的，改绑会让权益
   随身份漂移），请注意：**你在拒绝的那一刻是知道占用者是谁的**。若占用者其实是同一个人的另一个
   账号，只告诉用户「不行」而不告诉他「改用该第三方登录即可」，他大概率就走了。
6. **邮箱登录建号时把 `isNewUser` 透给客户端**。用户以为自己在登录、系统却建了新账号——这个
   落差只有在那一刻提示才来得及。

---

**相关**：`design.md`（为什么单飞 refresh、接入形态）· `protocol.md`（两端契约）·
`plan.md`（Logto 替换的分步计划与观察期读数）
