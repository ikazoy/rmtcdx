import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";

import puppeteer, { type Browser, type Page } from "puppeteer";

const MOBILE_VIEWPORT = {
  width: 393,
  height: 851,
  isMobile: true,
  deviceScaleFactor: 2,
  hasTouch: true
} as const;

const stylesheetPromise = readFile(new URL("./global.css", import.meta.url), "utf8");

let browser: Browser | null = null;

before(async () => {
  browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox"]
  });
});

after(async () => {
  await browser?.close();
  browser = null;
});

function buildMobileChatFixture(messageMarkup: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <div id="root">
      <div class="app-shell">
        <div class="workspace-shell" data-mobile-pane="chat">
          <main class="workspace-shell__chat" data-mobile-visible="true">
            <div class="chat-card" style="--composer-shell-height: 0px; --viewport-bottom-inset: 0px;">
              <div class="chat-topbar">
                <div class="chat-head">
                  <div class="chat-head__lead">
                    <div class="chat-head__copy">
                      <div class="chat-head__title">
                        <h2>Layout fixture</h2>
                      </div>
                      <p class="subtle">Mobile timeline overflow regression fixture</p>
                    </div>
                  </div>
                </div>
              </div>
              <div class="timeline-shell">
                <div class="timeline-wrap">
                  <div class="timeline">
                    ${messageMarkup}
                    <div class="timeline-end"></div>
                  </div>
                </div>
              </div>
              <div class="composer-shell">
                <div class="composer"></div>
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  </body>
</html>`;
}

async function openFixturePage(messageMarkup: string) {
  if (!browser) {
    throw new Error("browser not initialized");
  }

  const stylesheet = await stylesheetPromise;
  const page = await browser.newPage();
  await page.setViewport(MOBILE_VIEWPORT);
  await page.setContent(buildMobileChatFixture(messageMarkup), {
    waitUntil: "domcontentloaded"
  });
  await page.addStyleTag({ content: stylesheet });
  await page.waitForSelector(".timeline-wrap");
  return page;
}

async function measureHorizontalOverflow(page: Page, selectors: string[]) {
  return page.evaluate((targetSelectors) => {
    return targetSelectors.map((selector) => {
      const node = document.querySelector<HTMLElement>(selector);
      if (!node) {
        throw new Error(`Missing selector: ${selector}`);
      }

      return {
        selector,
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth
      };
    });
  }, selectors);
}

function assertNoHorizontalOverflow(
  measurements: Array<{ selector: string; scrollWidth: number; clientWidth: number }>
) {
  for (const measurement of measurements) {
    assert.equal(
      measurement.scrollWidth,
      measurement.clientWidth,
      `${measurement.selector} overflowed horizontally (${measurement.scrollWidth} > ${measurement.clientWidth})`
    );
  }
}

test("mobile thinking card does not introduce horizontal overflow in the timeline", { timeout: 30_000 }, async () => {
  const page = await openFixturePage(`
    <article class="message-row message-row--assistant">
      <div class="message-card message-card--assistant message-card--thinking message-card--kind-assistant_thinking">
        <p class="thinking-text">Thinking...</p>
      </div>
    </article>
  `);

  try {
    const measurements = await measureHorizontalOverflow(page, [
      ".timeline-wrap",
      ".timeline",
      ".message-row--assistant",
      ".message-card--thinking"
    ]);

    assertNoHorizontalOverflow(measurements);
  } finally {
    await page.close();
  }
});

test("mobile summary cards keep long rows clipped without widening the timeline", { timeout: 30_000 }, async () => {
  const page = await openFixturePage(`
    <article class="message-row message-row--system">
      <button class="summary-card summary-card--command" type="button">
        <header class="summary-card__head">
          <div class="summary-card__title-wrap">
            <strong>Command summary</strong>
            <span class="summary-card__chevron">›</span>
          </div>
        </header>
        <div class="summary-card__list">
          <div class="summary-card__row">
            <span class="summary-card__icon summary-card__icon--command">C</span>
            <div class="summary-card__row-copy">
              <span class="summary-card__row-line">
                <span class="summary-card__row-prefix">Bash</span>
                <span class="summary-card__row-text">/bin/zsh -lc 'mkdir -p /Users/ikazoy/workspace/8d/remote-control-codex/.artifacts/verify-data && printf %s test-output > /Users/ikazoy/workspace/8d/remote-control-codex/.artifacts/verify-data/result.txt'</span>
              </span>
              <span class="summary-card__row-detail">Long command output should stay visually clipped inside the card.</span>
            </div>
          </div>
        </div>
      </button>
    </article>
  `);

  try {
    const measurements = await measureHorizontalOverflow(page, [
      ".timeline-wrap",
      ".timeline",
      ".message-row--system",
      ".summary-card"
    ]);

    assertNoHorizontalOverflow(measurements);
  } finally {
    await page.close();
  }
});

test("mobile chat topbar spans the full chat width", { timeout: 30_000 }, async () => {
  const page = await openFixturePage("");

  try {
    const measurement = await page.evaluate(() => {
      const chatCard = document.querySelector<HTMLElement>(".chat-card");
      const topbar = document.querySelector<HTMLElement>(".chat-topbar");
      if (!chatCard || !topbar) {
        throw new Error("Missing topbar fixture");
      }

      return {
        chatCardWidth: chatCard.clientWidth,
        topbarWidth: topbar.clientWidth
      };
    });

    assert.ok(
      Math.abs(measurement.topbarWidth - measurement.chatCardWidth) <= 1,
      `.chat-topbar width ${measurement.topbarWidth} did not match .chat-card width ${measurement.chatCardWidth}`
    );
  } finally {
    await page.close();
  }
});
