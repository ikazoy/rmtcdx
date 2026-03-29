# Plan-First Workflow Design

## 1. 目的

本メモは、Codex Remote Web Client に
「スレッド単位で plan-first に進め、ユーザーが plan を承認したら実装へ進む」
体験を追加するための workflow 設計を整理する。

本書は planning / approval / implementation の流れに限定し、
execution permission や sandbox の詳細は
`docs/execution-permissions-design.md` に分離する。

## 2. 前提

- 対象 runtime は `codex app-server` 経由の real mode
- 対象確認バージョンは `codex-cli 0.116.0`
- 確認日は 2026-03-29
- 根拠は以下
  - OpenAI Codex docs
  - `codex app-server generate-ts`
  - `codex app-server generate-json-schema`
  - 現在の本リポジトリ実装

## 3. 結論

### 3.1 protocol 上、plan surface は存在する

Codex app-server には plan 関連 surface が存在する。

- thread item としての `plan`
- notification としての `item/plan/delta`
- notification としての `turn/plan/updated`

さらに、`turn/start` の生成 TypeScript 型には
`collaborationMode?: { mode: "plan" | "default", ... }`
が含まれている。

したがって、plan-first 体験は Codex の思想から外れた独自概念ではない。
ただし、確認できた surface は主に turn 単位であり、
「thread 自体が protocol 上で永続的に plan mode を持つ」とまでは言えない。

### 3.2 推奨は「thread-level の UX 設定」+「turn-level の実行」

ユーザー体験としては thread/session 単位で
`planFirst` を持たせてよい。
ただし protocol への反映は turn ごとに行うべきである。

つまり以下の分離が自然。

- アプリの session/thread 設定
  - このスレッドは plan-first で進めたい
- Codex への実行時反映
  - planning turn は `plan` 寄りで開始
  - implementation turn は通常モードで開始

### 3.3 plan 承認後は新しい turn で実装を開始する

推奨は、
plan approval を受けたら同じ thread 上で
新しい implementation turn を開始する形である。

以下の形は避ける。

- planning turn が裏でそのまま implementation に移る
- thread の mode 切り替えだけで自動継続する

理由:

- Codex の turn-centric なモデルに沿う
- どの plan を承認し、どの turn で実装に入ったかが明確
- history / audit 上の追跡がしやすい

## 4. 設計原則

### 4.1 turn が主たる実行単位

app-server docs でも conversation は
thread -> turn -> item
で整理されている。

したがって、workflow も turn を基準に構成する。

### 4.2 thread-level に見せるが protocol の真実にはしない

`planFirst` は remote client の product state として持つ。
これは Codex protocol の canonical state ではない。

そのため、
v1 では session DB に持てば十分であり、
無理に thread metadata と 1:1 対応させなくてよい。

### 4.3 plan approval は workflow 承認として扱う

`Approve and implement` は
「この方針で実装へ進んでよい」
という workflow 上の承認である。

execution permission や sandbox の扱いは別の責務とし、
本書では扱わない。

## 5. Protocol 調査メモ

### 5.1 plan に関する surface

確認できた主なもの:

- `turn/plan/updated`
- `item/plan/delta`
- thread item `type: "plan"`

生成 TypeScript では `TurnStartParams.collaborationMode` が存在し、
`mode` は `"plan" | "default"` である。

補足:

- JSON Schema bundle と generated TS で一部不整合があった
- `collaborationMode` は generated TS では確認できたが、
  JSON Schema の top-level properties には落ちていなかった
- したがって v1 では experimental / feature-detect 前提で扱うのが安全

## 6. 現状実装との差分

### 6.1 plan は履歴表示できるが live relay が足りない

本リポジトリでは `plan` message kind 自体は存在し、
thread item の `plan` を catalog 化して UI 表示できる。

ただし live では `turn/plan/updated` を relay していないため、
planning UX としてはまだ十分ではない。

### 6.2 thread-level workflow state を保持していない

現状は session/thread ごとに

- plan-first で進めるか
- approved plan があるか
- 実装待ちか

といった product state を保持していない。

このため、plan review から implementation 開始までを
一続きの workflow として扱えない。

## 7. 推奨プロダクト仕様

### 7.1 session/thread 単位で持つ状態

アプリ側の session metadata として、最低限以下を持つのがよい。

- `workflowMode`
  - `"default" | "planFirst"`
- `workflowState`
  - `"planning" | "readyToImplement" | "implementing"`
- `approvedPlan`
  - 最新承認 plan の snapshot
- `approvedPlanTurnId`
  - どの turn の plan を承認したか
- `approvedAt`
  - 承認時刻

### 7.2 planning turn の開始

session が `workflowMode = "planFirst"` の場合、
新しい planning turn は以下の方針で開始する。

1. `collaborationMode.mode = "plan"` が使える場合はそれを使う
2. 使えない場合は通常 turn に加えて
   planning 指示を developer/base instruction 側で補う

期待する振る舞いは以下。

- まず問題整理
- 実装案
- リスク
- step-by-step plan
- まだ勝手に実装しない

### 7.3 plan 承認後の実装開始

推奨 UX は以下。

1. planning turn が完了する
2. ユーザーが plan を確認する
3. ユーザーが `Approve and implement` を押す
4. アプリが同じ thread 上で新しい implementation turn を開始する

implementation 開始を implicit にせず、
明示的な user turn として残すことが重要である。

### 7.4 implementation turn の開始条件

implementation turn の開始時は以下を推奨する。

- `workflowState = "implementing"`
- `collaborationMode.mode = "default"` を優先
- approved plan の要約を context として渡す
- user-facing input は明示的に
  「承認済み plan に基づいて実装を開始してください」
  とする

### 7.5 plan 修正

plan approved 後でも以下は許可してよい。

- `Revise plan`
- `Back to planning`
- `Discard approved plan`

ただし approved plan は常に 1 つだけ current とし、
新しい承認が入ったら previous を履歴扱いにするのが分かりやすい。

## 8. UI 仕様案

### 8.1 session header

thread header 付近に以下を出す。

- workflow badge
  - `Plan First`
- current state
  - `Planning`
  - `Ready to implement`
  - `Implementing`

### 8.2 planning 完了後の action

planning turn の完了後、approved plan が無い場合は以下を出す。

- `Approve and implement`
- `Request revision`
- `Continue planning`

`Approve and implement` で new turn を開始する。

### 8.3 approved plan banner

approved plan がある場合、chat 上部に compact banner を出す。

表示内容の例:

- `Approved plan from 11:42`
- 対象 turn へのジャンプ
- `Revise`
- `Implement again`

## 9. 実装方針

### 9.1 bridge

bridge では以下が必要。

- `turn/start` に plan-first 用 override を渡せるようにする
- `turn/plan/updated` と `item/plan/delta` を relay する

### 9.2 shared types

最低限、以下の型拡張が必要。

- session workflow metadata
- live plan update event

### 9.3 web

web では以下が必要。

- session/thread settings UI
- plan review UI
- approve and implement action

### 9.4 persistence

v1 では session DB に保存すれば十分。

候補:

- session table に workflow columns を追加
- approved plan snapshot 用の別 table を追加

## 10. 推奨 v1 スコープ

最初の実装範囲は以下を推奨する。

1. `workflowMode = planFirst` の session 設定を追加
2. `turn/plan/updated` と `plan` item の live 表示を追加
3. `Approve and implement` を new turn として実装

逆に、以下は v2 以降でよい。

- plan revision diff の高度表示
- multiple approved plans の履歴 UI
- collaborative / multi-agent planning 固有 UX

## 11. 最終提案

ユーザー要望の
「スレッド単位でプランモードみたいに設定して、approve したら実装開始する」
は、Codex の思想に十分沿う形で実現できる。

ただし、実装の形は以下が望ましい。

- 見せ方は thread-level
- 実行は turn-level
- implementation 開始は new turn

execution permission や sandbox の扱いは別責務なので、
`docs/execution-permissions-design.md` で管理する。

## 12. 参考

- OpenAI Codex App Server
  - https://developers.openai.com/codex/app-server
- OpenAI Codex Advanced configuration
  - https://developers.openai.com/codex/config-advanced

