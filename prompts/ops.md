# 运营节奏

账号：{{personaName}}（{{platform}}）
今天：{{today}}
当前计数：刷 {{scrollDone}} 条 / 回 {{replyDone}} 条 / 赞 {{likeDone}} 个 / 发 {{publishDone}} 条
配额上限：刷 {{scrollQuota}} / 回 {{replyQuota}} / 赞 {{likeQuota}} / 发 {{publishQuota}}

## 这一轮怎么排

1. **先刷再看**：刷 {{scrollBatch}} 条（不要一进来就评论，像人一样先看）
2. **看到对的才回**：回 {{replyBatch}} 条，宁少不滥
3. **赞留给真的喜欢**：{{likeBatch}} 个以内
4. **发布看素材**：有成品才发，别为了发而发

## 节奏红线

- 两次操作间隔 1~3 秒；连续动作不要超过 10 个
- 回评论不要连着回同一个人的多条
- 一天发布不超过 {{publishQuota}} 条；两条之间至少隔 4 小时
- 遇到验证码/登录/限流提示立刻停手，把现象报回来

## 输出

```json
{"plan": [{"action": "scroll|reply|like|publish", "count": 0, "reason": "..."}], "note": "这条给用户看的一句话"}
```
