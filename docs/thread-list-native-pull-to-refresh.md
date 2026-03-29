# Thread List Native Pull-to-Refresh

## 1. 目的

本書は、モバイルのスレッド一覧で pull-to-refresh を
できるだけネイティブ挙動に寄せて実現するための方針を整理する。

対象は thread list 表示時の mobile sidebar であり、chat pane の
内部スクロール体験は原則維持する。

## 2. 結論

推奨方針は以下。

- custom gesture を `div` 上に実装するのではなく、可能な限り
  browser の native pull-to-refresh を使う
- そのために、mobile で sidebar を表示している間だけ
  thread list を root scroll に戻す
- chat 表示中は現状どおり internal scroll を維持する

要するに、常時 1 つの scroll model を押し通すのではなく、
mobile pane ごとに scroll responsibility を切り替える。

## 3. 現状の阻害要因

現状の UI は native pull-to-refresh と相性が悪い。

主な理由:

- `body` が `overflow: hidden`
- app shell / workspace shell が viewport 固定前提
- sidebar 一覧が `.sidebar-scroll` の内部スクロール
- `.sidebar-scroll` に `overscroll-behavior: contain` がある
- mobile では sidebar / chat を transform で重ねて切り替えている

この構成では、最上位の page scroll まで drag が届かないため、
ブラウザ組み込みの pull-to-refresh は基本的に発火しない。

## 4. 前提整理

### 4.1 native pull-to-refresh の前提

Web で native pull-to-refresh を使いたい場合、実質的には
「root scroller が上端で下方向に引かれる」状態を作る必要がある。

任意の内部スクロール要素に対して、browser 標準の pull-to-refresh を
直接付与する手段はない。

### 4.2 既存の data refresh は十分ある

データ取得レイヤーはすでに足りている。

- `sessionsQuery` の polling
- WebSocket event による `invalidateQueries`
- 手動 refresh 用に `refetch` を呼べる構造

したがって課題は API ではなく layout / scroll model 側にある。

## 5. 推奨アプローチ

## 5.1 mobile sidebar 表示中だけ root scroll に戻す

thread list を見ている間だけ、page 全体を自然に縦スクロールできる
状態にする。

その間は以下を満たす。

- `body` が縦スクロール可能
- `.sidebar-scroll` は internal scroll container にしない
- sidebar を内包する要素が content height に応じて伸びる
- thread list 最上端からの下 pull が root へ伝搬する

## 5.2 chat 表示中は現行構成を維持する

chat pane は以下の理由で internal scroll を残す。

- timeline pinned-to-bottom 制御がある
- composer を下部に安定配置している
- 既存の touch / wheel 制御が timeline 前提で組まれている

このため、chat まで root scroll に寄せると副作用が大きい。

## 5.3 scroll model を pane ごとに切り替える

推奨する責務分離:

- mobile + sidebar visible:
  - root scroll
- mobile + chat visible:
  - internal scroll
- desktop:
  - 現状維持

## 6. 実装方針

### 6.1 CSS だけで押し切らない

方向性は CSS-first でよいが、完全な CSS only は推奨しない。

理由:

- `body` の scroll 制御を pane 状態に応じて切り替えたい
- hidden pane の扱いを transform ベースの重ね表示から
  少し明示的にしたい
- sidebar mode と chat mode で高さ / overflow の責務が異なる

そのため、最小限の state hook を DOM に露出させる方が安全である。

例:

- `workspace-shell` に `data-mobile-pane="sidebar" | "chat"` を付与
- 必要なら `document.body.dataset.mobilePane` も同期

### 6.2 mobile sidebar mode の CSS 変更

sidebar 表示時に限り、以下のような変更を適用する。

- `body`
  - `overflow-y: auto`
- `.app-shell`, `.workspace-shell`
  - `height: auto`
  - `min-height: 100dvh`
- `.workspace-shell__sidebar`
  - `overflow: visible`
- `.sidebar-shell`, `.sidebar-card`
  - `height: auto`
  - `min-height: 100dvh`
  - `overflow: visible`
- `.sidebar-scroll`
  - `flex: 0 0 auto`
  - `min-height: auto`
  - `overflow: visible`
  - `overscroll-behavior: auto`

狙いは、一覧全体を page content として積み上げ直すことにある。

### 6.3 mobile pane の切り替え方法を見直す

現状の transform ベースの overlay 切り替えは、
native pull-to-refresh 観点では都合が悪い。

mobile sidebar mode では、少なくとも sidebar 側は
「見えている overlay」ではなく「そのまま page content」として
存在させるのが望ましい。

候補:

- sidebar mode では chat pane を `display: none`
- chat mode では sidebar pane を `display: none`

desktop では現状どおり 2 カラムを維持する。

### 6.4 sticky footer の確認

sidebar footer の `position: sticky` は root scroll 化後も使える可能性が高いが、
以下を確認する。

- mobile Safari で footer が不自然に重ならないか
- safe-area inset と競合しないか
- list scroll 中の引っかかりが出ないか

必要なら mobile sidebar mode だけ sticky を外す。

## 7. 非推奨案

### 7.1 custom pull gesture の追加

React 側で touchstart / touchmove / touchend を監視して
疑似 pull-to-refresh を実装する案は、今回の優先方針ではない。

理由:

- native より挙動が不安定になりやすい
- inertia / overscroll / rubber-band と競合しやすい
- OS / browser の期待と微妙にずれやすい

### 7.2 常時 root scroll 化

app 全体を常に root scroll に戻す案も避ける。

理由:

- chat timeline と composer の既存 UX を崩しやすい
- pinned-to-bottom 制御と競合しやすい
- desktop の現行レイアウトまで巻き込みやすい

## 8. 実装ステップ案

1. `workspace-shell` に mobile pane 状態を露出する
2. mobile sidebar mode 専用の CSS を追加する
3. `.sidebar-scroll` を root scroll に寄せる
4. mobile sidebar mode では hidden pane を `display: none` にする
5. iOS Safari / Android Chrome で native pull-to-refresh を確認する
6. sticky footer と safe-area の見え方を微調整する

## 9. 受け入れ条件

以下を満たせば本方針は成功とみなす。

- mobile で sidebar 表示中、thread list 最上端からの下 pull で
  browser 標準の refresh が発火する
- chat 表示中の timeline / composer 挙動が退行しない
- desktop layout に影響しない
- 既存の query / WebSocket 更新フローに変更を要求しない

## 10. 想定コスト

概算は以下。

- 最小実装:
  - 半日程度
- iOS / Android 実機または近い環境での調整込み:
  - 半日から 1 日程度

工数の中心は fetch 実装ではなく、mobile layout と overflow の
責務整理にある。
