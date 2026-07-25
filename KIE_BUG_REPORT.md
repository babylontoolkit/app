# Bug report: Claude adapter returns EMPTY thinking text (all models) while billing thinking tokens

**To:** KIE support (api.kie.ai)
**From:** (your account email / API key ID here)
**Date:** 2026-07-24
**Endpoint:** `POST https://api.kie.ai/claude/v1/messages` (streaming)

## Summary

Since at least 2026-07-24, the Claude adapter streams **thinking blocks whose text is empty for every model we tested** — including models where it previously worked — while `output_tokens_details.thinking_tokens` continues to accrue (and be billed). The identical request against Anthropic's own API returns summarized thinking text streamed live, so the fault is in the adapter, not the request shape.

This is a **regression**: on 2026-07-17 we measured `claude-fable-5` returning 224/223 chars of thinking text with `thinkingFlag: true`. Today the same request returns 0 chars — even on a forced 2,980-token think.

## Request shape (exact)

```json
POST /claude/v1/messages
Authorization: Bearer <API_KEY>
anthropic-version: 2023-06-01
content-type: application/json

{
  "model": "claude-opus-4-8",
  "max_tokens": 3000,
  "stream": true,
  "thinking": { "type": "adaptive", "display": "summarized" },
  "output_config": { "effort": "medium" },
  "thinkingFlag": true,
  "messages": [
    {
      "role": "user",
      "content": "Three friends split a restaurant bill. Alice pays twice what Bob pays. Carol pays $6 less than Alice. The total is $54. Think through this carefully step by step, then state each share. After that, briefly design a scoring system for a kart racing game with drift bonuses."
    }
  ]
}
```

`thinkingFlag: true` is included per your adapter's documented requirement ("project-specific thinking flag used by the current Claude adapter").

## Measured results (2026-07-24)

| Model | Route | `thinking_tokens` billed | Thinking text chars received |
|---|---|---|---|
| claude-opus-4-8 | api.kie.ai | 103 (2nd trial: 254) | **0** |
| claude-opus-4-7 | api.kie.ai | 80 | **0** |
| claude-fable-5 | api.kie.ai | 56 | **0** |
| claude-fable-5 (forced long think) | api.kie.ai | **2,980** | **0** |
| claude-opus-4-8 (control, same body minus `thinkingFlag`) | **api.anthropic.com** | 121 | **209 — streamed live during the think** |

For reference, our 2026-07-17 measurements through your adapter (same request shape): claude-opus-4-6 → 196/196/196 chars, claude-opus-4-5 → 410/405/642, claude-sonnet-4-5 → 211/215/230, claude-fable-5 → 224/223. So the adapter previously passed thinking text through for documented models; today it does not for any model we tested.

## Wire-level detail

On every KIE trial the SSE stream looks like this:

```
[~2s]   message_start  (usage shows input + cache tokens)
        ... silence (one ping) for the entire thinking window ...
[end]   content_block_start  index=0  type=thinking
        content_block_delta  thinking_delta  { "thinking": "" }     <-- EMPTY
        content_block_delta  signature_delta
        content_block_start  index=1  type=text
        content_block_delta  text_delta ...                          <-- answer streams normally
        message_delta  usage.output_tokens_details.thinking_tokens = <non-zero>
```

Two problems visible there:

1. **The thinking text is empty** (`thinking_delta` carries `""`), yet `thinking_tokens` is non-zero and billed. We are paying for reasoning we cannot display.
2. **The thinking block arrives at the end of the think**, so during a long reasoning window (minutes, on large coding tasks) the stream is completely silent. On Anthropic directly, the summarized thinking streams *during* the think.

## Expected behavior

With `thinking: { "type": "adaptive", "display": "summarized" }` (+ `thinkingFlag: true` per your adapter), summarized thinking text should stream in `thinking_delta` events during the reasoning window — as Anthropic's API does with the same body, and as your adapter itself did on 2026-07-17.

## Impact

Our platform streams model reasoning to end users while long thinks run. With this regression every user-facing generation shows minutes of dead air while thinking tokens are billed. It affects all our traffic on claude-opus-4-8 / claude-opus-4-7 / claude-fable-5.

## Ask

1. Restore thinking-text passthrough (`thinking_delta` content) for summarized adaptive thinking, on all Claude models the adapter serves — including claude-opus-4-8, which has returned empty thinking text since we first measured it on 2026-07-17.
2. Confirm whether `thinkingFlag: true` is still the correct/required mechanism, and whether the empty-text behavior is expected under any configuration.

Happy to provide raw SSE captures or re-run any trial on request.
