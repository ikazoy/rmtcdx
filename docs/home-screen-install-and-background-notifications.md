# Home Screen Install and Background Notifications

## 1. 目的

本書は、Codex Remote Web Client をスマホで
「アプリアイコンからすぐ起動できる」体験に寄せつつ、
run 完了時の通知をバックグラウンド中にも届けるための
要件と方針を整理する。

ここでの主目的は以下の 2 点である。

- ホーム画面にアプリアイコンとして置けること
- run 完了または error を、アプリが前面にない状態でも通知できること

一方で、以下は今回の対象外とする。

- オフライン動作
- 完全な PWA オフラインキャッシュ戦略
- ネイティブアプリ化

## 2. 結論

要件は 2 つに分けて扱うのが正しい。

### 2.1 ホーム画面アイコン化

これは軽量実装でよい。

- `manifest.webmanifest`
- アプリアイコン
- `apple-touch-icon`
- standalone 起動向け meta / CSS

この範囲では service worker は不要である。

### 2.2 バックグラウンド通知

これは別レイヤーの要件であり、軽量実装では済まない。

- Notification / Push 系 API は secure context 前提
- モバイルで確実なバックグラウンド通知を行うには
  `Push API + service worker + HTTPS` が必要
- offline は不要だが、push 受信のための service worker は必要

したがって、今回の方針は以下になる。

- フェーズ 1:
  ホーム画面アイコン化と standalone 起動体験を整える
- フェーズ 2:
  画面を開いている間の通知を強化する
- フェーズ 3:
  HTTPS 化した配信経路で Web Push を導入し、
  バックグラウンド通知を実現する

## 3. 現状整理

現状のアプリには、通知導線として再利用できる下地がすでにある。

- bridge から build 済み SPA を配信できる
- run イベントは WebSocket でクライアントへ流れている
- `run.completed` / `run.error` / `run.interrupted` は
  クライアント側で受信している
- 未読完了件数は `document.title` に反映している

関連箇所:

- `apps/bridge/src/realtime/realtime-gateway.ts`
- `apps/web/src/hooks/use-realtime.ts`
- `apps/web/src/app/App.tsx`

つまり、

- 「開いている間の通知」は既存 WebSocket に乗せられる
- 「閉じていても届く通知」は別途 Push 経路が必要

という切り分けになる。

## 4. 要件

## 4.1 必須要件

- スマホのホーム画面にアイコンとして追加できる
- アイコン起動時に browser tab 感をなるべく減らす
- run 完了時にユーザーが気付きやすい
- error 時は完了通知より強く気付ける
- 将来的にバックグラウンド通知へ拡張できる構成にする

## 4.2 追加要件

- iPhone / Android の両方で破綻しない
- 既存の WebSocket ベース更新フローを活かす
- offline 用キャッシュは入れない
- 通知 click 時に対象 session へ戻れる

## 4.3 非要件

- 電波がない状態での利用
- 全 API 応答のキャッシュ
- app store 配布

## 5. プラットフォーム制約

### 5.1 ホーム画面追加と PWA install は別問題

ホーム画面に追加できることと、
バックグラウンド通知が使えることは同義ではない。

- iOS / iPadOS では install prompt は出ない
- ユーザーが share menu から手動で
  Add to Home Screen する前提になる
- iOS では `apple-touch-icon` を入れないと
  見た目が不安定になりやすい

### 5.2 LAN の HTTP URL では push 前提を満たせない

現在のような `http://<LAN-IP>:5173` は、
`localhost` / `127.0.0.1` と違って secure context ではない。

そのため、バックグラウンド通知の本命である
service worker / Push API を前提にした構成へ進むには、
HTTPS 配信経路が必要になる。

### 5.3 service worker は push 用にだけ使う

今回の要件では offline は不要なので、
service worker を導入しても asset caching を積極利用しない。

service worker の役割は以下に限定する。

- push 受信
- notification click 処理
- 必要なら起動時 deep link 補助

## 6. 推奨アーキテクチャ

## 6.1 フェーズ 1: ホーム画面アイコン化

目的は「スマホから 1 タップでアプリっぽく戻れる状態」を作ること。

実装範囲:

- `apps/web/public/manifest.webmanifest` を追加
- `192x192` / `512x512` アイコンを追加
- `apple-touch-icon` を追加
- `index.html` に以下を追加
  - `manifest`
  - `theme-color`
  - iOS 用 meta
- standalone 起動時の safe-area / 上部余白 / 背景色を調整
- 初回アクセス時に
  「ホーム画面に追加する方法」を簡潔に案内する

運用方針:

- 日常利用は Vite dev server より
  bridge が返す build 済み UI を優先する
- `:5173` は開発確認用、
  常用 URL は bridge 側に寄せる

## 6.2 フェーズ 2: 画面を開いている間の通知強化

これは Push 導入前の即効性ある改善。

実装範囲:

- `run.completed` で toast を出す
- `run.error` で error toast を出す
- 必要なら完了音を追加する
- `document.visibilityState` が `hidden` のときだけ
  通知表現を強める

通知条件の推奨:

- 自分が開始した run の完了時のみ通知する
- 連続完了は session 単位でまとめる
- error は常に通知候補にする

注意:

- モバイル browser が background 中にページ実行を止めることがある
- そのため、このフェーズだけでは
  「バックグラウンド通知の保証」にはならない

## 6.3 フェーズ 3: バックグラウンド通知

本要件の本命はここ。

構成:

- HTTPS で配信する
- service worker を登録する
- Push subscription を取得する
- bridge で subscription を保存する
- run 完了時に bridge から Web Push を送る

通知トリガー:

- `run.completed`
- `run.error`

通知 payload の最小案:

- title:
  `Codex Remote`
- body:
  `"<session title>" finished` あるいは `error`
- data:
  `sessionId`, `runId`, `repoId`

notification click 時の挙動:

- 既存 window があれば focus
- なければ app を開く
- 対象 session を自動選択する

## 6.4 通知設定モデル

初期実装では複雑にしすぎない。

推奨設定:

- 通知許可:
  on / off
- 完了通知:
  on / off
- error 通知:
  on / off

将来的な拡張候補:

- repo 単位通知
- session 単位通知
- 自分が開始した run のみ通知

## 7. データモデル案

最低限、bridge 側で push subscription を file-backed state に保持する必要がある。

候補 state object:

- `notifications.subscriptions[]`

候補フィールド:

- `endpoint`
- `expiration_time`
- `p256dh`
- `auth`
- `user_agent`
- `platform`
- `created_at`
- `updated_at`
- `last_seen_at`
- `enabled`

必要に応じて以下も持つ。

- `device_label`
- `notify_on_complete`
- `notify_on_error`

初期段階では user 概念が薄いため、
subscription は「この bridge を見ている端末」に紐づく前提でよい。

## 8. 実装ステップ案

1. フェーズ 1 のホーム画面アイコン化を実装する
2. bridge 配信の常用 URL を決める
3. フェーズ 2 の in-app 通知を追加する
4. HTTPS 配信方法を決める
5. service worker を push 専用用途で導入する
6. push subscription API を bridge に追加する
7. subscription を state file に保存する
8. `run.completed` / `run.error` で push 送信する
9. notification click で session deep link を開く

## 9. 受け入れ条件

## 9.1 フェーズ 1

- iPhone / Android でホーム画面に追加できる
- 追加後のアイコンがスクリーンショットではなく
  意図したアプリアイコンになる
- アイコン起動時に standalone 風の UI になる
- offline での特別な挙動は実装しない

## 9.2 フェーズ 2

- アプリを開いている間は
  run 完了と error を即時に視認できる
- 連続 run で通知が過剰にならない

## 9.3 フェーズ 3

- アプリが background 中でも完了通知が届く
- error 通知が届く
- 通知 tap で対象 session に戻れる
- offline cache を前提にしなくても通知機能は成立する

## 10. リスクと留意点

- dev server (`:5173`) は常用 URL に向かない
- HTTPS 化しない限り、
  バックグラウンド通知は最終的には成立しない
- iOS は install prompt がないため、
  UI 側で手順案内が必要
- service worker を入れても、
  offline をやらない方針は維持できる

## 11. 参考

- MDN Notifications API:
  https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API
- MDN Push API:
  https://developer.mozilla.org/en-US/docs/Web/API/Push_API
- MDN Secure Contexts:
  https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts
- web.dev Installation:
  https://web.dev/learn/pwa/installation/
