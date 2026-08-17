# 取数清单

人肉取数用。指标定义与口径出处见 [../docs/stats-design.md](../docs/stats-design.md)，本目录只解决「怎么把数捞出来、怎么不读错」。

自动化（日报 / 告警）**尚未做**，理由是流量还没起来，先人肉。将来无论做成 cron、Actions 还是别的，SQL 都从这里取，不另起一份。

## 怎么执行

每个消费方的数据在**各自的 D1 里**，两边分开查、不合并（不同 App、不同用户群，指标合并没有意义）。

```bash
# Tono-Server
cd /Users/wanghl/TonoProjects/Tono-Server
npx wrangler d1 execute tono-db --remote --command "<粘贴单节 SQL>"

# github-ai-trending-api
cd /Users/wanghl/TrendingProjects/github-ai-trending-api
npx wrangler d1 execute trending --remote --command "<粘贴单节 SQL>"
```

加 `--json` 可拿到机器可读输出。**注意 `--remote`**，漏了就查到本地空库、看见一堆 0 还以为线上没人用。

## 例行节奏（建议）

| 频率 | 看什么 |
|---|---|
| 每天（10 秒） | `00 哨兵` 一条。返回空就收工 |
| 每周 | `01 总览` + `D11 回跳丢失` + `F2 续期健康` |
| 有事时 | 按指标编号下钻，个案用文件末尾的 `flow_id` 追踪 |

## 五条最容易读错的

1. **时区**。`at` 存 UTC 毫秒，所有分天查询都写了 `+28800` 按 Asia/Shanghai 切。上次三源取数就是 UTC 与 CST 混读，8 小时差把一天的量摊到了两天。

2. **`sessions` 表的行数不是登录次数**。每次 refresh 都插一行，直接 `COUNT(*)` 会严重虚高——那张表里一次登录要用 `COUNT(DISTINCT family_id)`。`auth_events` 里则直接数 `event='login'`，没有这个坑。

3. **「登录成功」的口径是客户端真正拿到 token**。GitHub 轨的 `login` 事件发在 `oauth_exchange` 成功时，不是 callback。所以 `oauth_callback:issued` 比 `login` 多出来的那部分**不是 bug，正是 D11 要量的回跳丢失**。

4. **国家会被代理系统性扭曲，而且是偏向性的**。访问 GitHub 授权页本身就要代理，所以 `provider='github'` 的国家分布天然偏向 US/JP/SG。产品口径看邮箱轨或 K3 归属国；`oauth_callback` 那些行的国家当「代理出口分布」读。**K9 的 ASN 是唯一能戳穿这件事的字段**——云厂商 ASN ≈ 代理。（首条生产数据就是活例：人在杭州，记录是 `US / AS45102 / SJC`。）

5. **`stats_unavailable` 在这张表里查不到**。它是「表写不进去」时发的告警，只走 `onEvent`（Workers Logs，保留 7 天），按定义不可能落在 `auth_events` 里。怀疑某个消费方漏跑迁移时，去 Workers Logs 搜这个事件名，或直接查表在不在。

## 一个必须记住的前提

**统计写入失败是被静默吞掉的**——这是 loginbase 的设计（统计不能成为登录的故障源）。代价是：查出来是 0，可能真是 0，也可能是表没了、迁移漏跑、字段对不上。

数长期为 0 时，先确认表还在、还在写，再下「没人用」的结论。
