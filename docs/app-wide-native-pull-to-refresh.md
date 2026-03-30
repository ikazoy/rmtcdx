# App-Wide Native Pull-to-Refresh

## 1. 目的

本書は、mobile Web UI 全体で browser の native pull-to-refresh を
成立させるための設計方針を定義する。

対象は以下の全画面である。

- スレッド一覧
- スレッド詳細の chat 画面
- session detail に紐づく通常の mobile navigation

目標は、画面ごとに scroll model を切り替えるのではなく、
mobile では app 全体を同じ scroll responsibility で扱えるようにすること。

## 2. 結論

採用すべき方針は以下である。

- mobile では app 全体の主スクロールを root scroll に統一する
- native pull-to-refresh は screen ごとに作り分けず、
  browser の page reload として受け入れる
- sidebar / chat を問わず、primary vertical scroll を内部要素に持たせない
- desktop は現状の internal layout を維持する

要するに、今回の target は
「sidebar でも chat でも、最上位 page を引けば同じように refresh される」
状態である。

## 3. 背景

現状の sidebar 向け実装は、mobile の thread list だけを
root scroll に戻す中間対応である。

これは thread list では機能するが、chat では依然として
internal scroll 前提が残る。

その結果、mobile app 全体としては以下の問題が残る。

- screen ごとに scroll model が違う
- native pull-to-refresh の有無が画面ごとに変わる
- chat は再読み込みで全体 refresh できない
- layout と scroll の責務が pane ごとに分岐している

この状態は最終形としては不自然であり、
scroll model を app-wide に統一した方が保守しやすい。

## 4. 現状構成の問題

現行の mobile chat は internal scroll を前提に組まれている。

主な要因:

- `body` は通常 `overflow: hidden`
- `.chat-card` が `overflow: hidden`
- `.timeline-wrap` が `overflow: auto`
- auto-follow / jump-to-latest の判定が
  `timelineRef.scrollTop` を前提にしている
- composer は flex layout の末尾に置かれ、
  chat pane 自体が viewport 高さ前提で固定されている

このため、chat で native pull-to-refresh を成立させるには、
単に CSS を少し変えるだけでは足りない。

## 5. 設計原則

### 5.1 mobile の primary vertical scroll は root のみ

mobile では、ユーザーが上下にたどる主経路を
必ず `document.scrollingElement` に集約する。

許容する internal scroll は以下に限定する。

- code block
- terminal block
- bottom sheet body
- image viewer
- textarea の内部スクロール

つまり、主画面そのものの縦移動だけは root に統一する。

### 5.2 screen ごとの scroll mode 分岐をやめる

`sidebar` と `chat` で

- どちらが root scroll か
- どちらが internal scroll か

を切り替える設計は採らない。

残してよい分岐は以下のみ。

- mobile / desktop の breakpoint 差
- overlay open 中の一時的な body scroll lock

### 5.3 native pull-to-refresh は hard reload とみなす

native pull-to-refresh は query refetch ではなく、
browser による page reload として扱う。

そのため、実装目標は
「reload に強い state を持つこと」であって、
「reload を避けること」ではない。

## 6. 期待する UX

mobile で以下が成立することを目指す。

- thread list で上端から下に引くと browser が refresh する
- chat timeline の上端から下に引いても同じく refresh する
- refresh 後も URL と永続 state に基づいて自然に元の文脈へ戻る
- screen ごとに refresh 動作が変わらない

期待しないこと:

- native refresh 中に unsent composer state を完全保持すること
- bottom sheet や image viewer を開いたまま refresh できること

## 7. 状態保持ポリシー

native refresh によって維持されるべき state と、
失われても許容する state を分ける。

### 7.1 維持したい state

以下は reload 後に自然復元されるべきである。

- 選択 session
  - URL で復元
- 選択 repo
  - localStorage で復元
- thread list の search / filter
  - localStorage で復元
- repo collapse 状態
  - localStorage で復元

### 7.2 v1 では失われても許容する state

以下は native refresh で消えてよい。

- composer の未送信テキスト
- 添付前の画像選択状態
- open 中の actions menu
- bottom sheet / image viewer の open state
- 一時的な streaming / activity state

理由:

- native refresh は hard reload であり、完全保持を目指すと設計が重くなる
- session URL と persisted filter が戻れば、再開のコストは限定的である

### 7.3 将来拡張

将来的に必要なら、以下を sessionStorage に退避できる。

- chat composer draft
- draft attached image の metadata

ただしこれは app-wide root scroll 化の必須条件ではない。

## 8. レイアウト設計

### 8.1 mobile app shell を content-driven にする

mobile では、app shell を viewport 固定ではなく content-driven に寄せる。

意図:

- page 全体が自然に伸びる
- root scroll が primary scroll になる
- pull gesture が scroll container に奪われない

方針:

- `body`, `#root`, `.app-shell`, `.workspace-shell` は
  `height: auto` を基本にする
- `min-height: 100dvh` は維持して、最低限 viewport は埋める
- mobile では `overflow: hidden` を主レイアウトから外す

### 8.2 pane visibility と scroll semantics を分離する

pane の表示 / 非表示は維持してよいが、
scroll semantics を pane に紐づけない。

つまり、`mobilePane` は

- どちらを見せるか

だけを表し、scroll model まで担わせない。

### 8.3 chat layout を root-scroll 前提へ再構成する

mobile chat は以下のように組み替える。

- `.chat-card`
  - `height: auto`
  - `overflow: visible`
- `.timeline-shell`
  - `flex: 0 0 auto` 相当に戻す
  - fixed-height container にしない
- `.timeline-wrap`
  - `overflow: visible`
  - `overscroll-behavior: auto`
- `.timeline`
  - 通常の content block として積む

これにより、chat timeline 自体が page content になる。

### 8.4 composer は root-scroll 前提で再配置する

composer は internal flex anchoring をやめ、
mobile では viewport bottom に追従する UI として再定義する。

推奨順序:

1. `position: sticky` + `bottom: 0`
2. 必要なら `position: fixed`

`sticky` で成立するならその方が keyboard / safe-area と相性が良い。
ただし安定しない場合は `fixed` を採用し、
timeline 側に composer 高さぶんの bottom padding を入れる。

### 8.5 jump-to-latest は viewport 基準へ移す

現在の jump-to-latest は `.timeline-shell` 内 absolute 配置である。
root scroll 化後は、基準を timeline container から viewport へ移す必要がある。

候補:

- mobile では `position: fixed`
- desktop では現状維持

## 9. 挙動設計

### 9.1 auto-follow 判定の基準を root scroll へ移す

chat の auto-follow は `timelineRef.scrollTop` 依存をやめ、
`document.scrollingElement` 基準へ移す。

少なくとも以下を再設計する。

- 現在地が bottom 近傍か
- 上方向スクロールで auto-follow を外す判定
- 新規 message 到着時に bottom へ送る判定
- jump-to-latest の表示条件

### 9.2 scroll listener は window/document に移す

mobile では scroll event の主読取先を以下に寄せる。

- `window`
- `document.scrollingElement`

`timelineRef` は message container の参照として残ってもよいが、
primary scroll state の source of truth にはしない。

### 9.3 scroll-to-bottom は page scroll として実装する

chat 末尾へのジャンプは、
timeline element への `scrollTo` ではなく、
document 全体の scroll を使う。

具体的には以下のいずれか。

- `window.scrollTo({ top: documentHeight, behavior })`
- composer sentinel への `scrollIntoView`

後者の方が DOM 変化に強く、推奨である。

## 10. overlay / modal の扱い

bottom sheet と image viewer は例外として扱う。

これらは主画面ではなく overlay であり、以下を維持してよい。

- fixed positioning
- body scroll lock
- 独立した internal scroll

理由:

- open 中は native pull-to-refresh を起こさない方が自然
- gesture と overlay drag が競合しやすい

したがって、overlay open 中だけ一時的に root scroll を止めるのは許容する。

## 11. 実装方針

### 11.1 段階導入する

一気に全て変えるのではなく、以下の順で進める。

1. mobile の scroll source を app-wide に統一する
2. chat の auto-follow と jump-to-latest を root scroll 対応に置き換える
3. composer の配置を root-scroll 前提で安定化する
4. sidebar-only 向け CSS を削除し、app-wide ルールへ置換する

### 11.2 sidebar-only 対応は最終的に削除する

現在の `body[data-mobile-pane="sidebar"]` 前提の CSS は、
transition 用の一時実装として扱う。

target では以下に置き換える。

- mobile 全体に共通する root-scroll ルール
- chat / sidebar どちらにも依存しない scroll semantics

### 11.3 desktop を巻き込まない

desktop は現行 UX が成立しているため、
今回の refactor は mobile breakpoint に限定する。

## 12. 受け入れ条件

以下を満たしたら設計目標達成とみなす。

- mobile の sidebar / chat どちらでも native pull-to-refresh が発火する
- refresh 後に現在の session URL へ自然復帰する
- repo 選択や thread filter が保持される
- chat の auto-follow / jump-to-latest が実用上退行しない
- composer が keyboard と safe-area を含めて破綻しない
- overlay open 中は body scroll lock が保たれる
- desktop layout に影響しない

## 13. 想定リスク

主なリスクは以下。

- mobile keyboard と sticky/fixed composer の相性
- jump-to-latest の viewport 固定化に伴う視覚調整
- streaming 中の auto-follow 判定が root scroll 化で不安定になること
- message 内の大きな code block が root scroll と内部横スクロールで干渉すること

このため、最終判断は desktop browser のレスポンシブ確認だけでなく、
Android Chrome と iOS Safari の実機確認を前提にするべきである。

## 14. 想定工数

概算は以下。

- layout refactor:
  - 0.5 から 1 日
- auto-follow / jump-to-latest / composer 調整:
  - 1 から 2 日
- 実機検証と微調整:
  - 0.5 から 1 日

合計では 2 から 4 日程度を見込むのが妥当である。
