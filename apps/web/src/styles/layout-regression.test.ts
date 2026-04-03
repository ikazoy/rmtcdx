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

function buildMobileChatFixture(
  messageMarkup: string,
  composerMarkup = '<div class="composer"></div>',
  options: {
    displayMode?: "browser" | "standalone";
  } = {}
) {
  const bodyAttributes = options.displayMode ? ` data-display-mode="${options.displayMode}"` : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body${bodyAttributes}>
    <div id="root">
      <div class="app-shell">
        <div class="workspace-shell" data-mobile-pane="chat">
          <main class="workspace-shell__chat" data-mobile-visible="true">
            <div class="chat-card" style="--composer-shell-height: 0px; --viewport-bottom-inset: 0px;">
              <div class="chat-topbar">
                <div class="chat-head">
                  <div class="chat-head__lead">
                    <div class="chat-toolbar__left chat-head__nav">
                      <button class="ghost-button ghost-button--back" type="button" aria-label="Back to sidebar">
                        <svg viewBox="0 0 24 24" aria-hidden="true"></svg>
                      </button>
                    </div>
                    <div class="chat-head__copy">
                      <div class="chat-head__title">
                        <h2>Layout fixture</h2>
                      </div>
                      <p class="subtle">Mobile timeline overflow regression fixture</p>
                    </div>
                  </div>
                  <div class="sidebar-menu chat-head__menu">
                    <button class="sidebar-menu__trigger chat-head__menu-trigger" type="button" aria-label="Open thread actions">
                      <svg viewBox="0 0 24 24" aria-hidden="true"></svg>
                    </button>
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
                ${composerMarkup}
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  </body>
</html>`;
}

async function openFixturePage(
  messageMarkup: string,
  composerMarkup?: string,
  options: {
    displayMode?: "browser" | "standalone";
  } = {}
) {
  if (!browser) {
    throw new Error("browser not initialized");
  }

  const stylesheet = await stylesheetPromise;
  const page = await browser.newPage();
  await page.setViewport(MOBILE_VIEWPORT);
  await page.setContent(buildMobileChatFixture(messageMarkup, composerMarkup, options), {
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

test("mobile browser chat topbar sits flush with the chat card top edge", { timeout: 30_000 }, async () => {
  const page = await openFixturePage("");

  try {
    const measurement = await page.evaluate(() => {
      const chatCard = document.querySelector<HTMLElement>(".chat-card");
      const topbar = document.querySelector<HTMLElement>(".chat-topbar");
      if (!chatCard || !topbar) {
        throw new Error("Missing topbar fixture");
      }

      return {
        chatCardTop: chatCard.getBoundingClientRect().top,
        topbarTop: topbar.getBoundingClientRect().top
      };
    });

    assert.ok(
      Math.abs(measurement.topbarTop - measurement.chatCardTop) <= 1,
      `.chat-topbar top ${measurement.topbarTop} did not align with .chat-card top ${measurement.chatCardTop}`
    );
  } finally {
    await page.close();
  }
});

test("mobile browser chat topbar keeps comfortable top padding inside the header", { timeout: 30_000 }, async () => {
  const page = await openFixturePage("");

  try {
    const browserPaddingTop = await page.evaluate(() => {
      const topbar = document.querySelector<HTMLElement>(".chat-topbar");
      if (!topbar) {
        throw new Error("Missing browser topbar fixture");
      }

      return Number.parseFloat(window.getComputedStyle(topbar).paddingTop);
    });

    assert.ok(browserPaddingTop >= 7, `browser padding-top ${browserPaddingTop} was smaller than the expected header breathing room`);
  } finally {
    await page.close();
  }
});

test("mobile standalone chat topbar keeps at least the browser top padding baseline", { timeout: 30_000 }, async () => {
  const browserPage = await openFixturePage("");
  const standalonePage = await openFixturePage("", undefined, { displayMode: "standalone" });

  try {
    const browserPaddingTop = await browserPage.evaluate(() => {
      const topbar = document.querySelector<HTMLElement>(".chat-topbar");
      if (!topbar) {
        throw new Error("Missing browser topbar fixture");
      }

      return Number.parseFloat(window.getComputedStyle(topbar).paddingTop);
    });

    const standalonePaddingTop = await standalonePage.evaluate(() => {
      const topbar = document.querySelector<HTMLElement>(".chat-topbar");
      if (!topbar) {
        throw new Error("Missing standalone topbar fixture");
      }

      return Number.parseFloat(window.getComputedStyle(topbar).paddingTop);
    });

    assert.ok(
      standalonePaddingTop >= browserPaddingTop,
      `standalone padding-top ${standalonePaddingTop} was smaller than browser padding-top ${browserPaddingTop}`
    );
  } finally {
    await browserPage.close();
    await standalonePage.close();
  }
});

test("mobile chat header back button matches the actions button size and top alignment", { timeout: 30_000 }, async () => {
  const page = await openFixturePage("");

  try {
    const measurement = await page.evaluate(() => {
      const backButton = document.querySelector<HTMLElement>(".ghost-button--back");
      const menuButton = document.querySelector<HTMLElement>(".chat-head__menu-trigger");
      if (!backButton || !menuButton) {
        throw new Error("Missing chat header controls");
      }

      const backRect = backButton.getBoundingClientRect();
      const menuRect = menuButton.getBoundingClientRect();

      return {
        backTop: backRect.top,
        menuTop: menuRect.top,
        backHeight: backRect.height,
        menuHeight: menuRect.height,
        backWidth: backRect.width,
        menuWidth: menuRect.width
      };
    });

    assert.ok(Math.abs(measurement.backTop - measurement.menuTop) <= 2, `back button top ${measurement.backTop} did not align with menu top ${measurement.menuTop}`);
    assert.ok(Math.abs(measurement.backHeight - measurement.menuHeight) <= 1, `back button height ${measurement.backHeight} did not match menu height ${measurement.menuHeight}`);
    assert.ok(Math.abs(measurement.backWidth - measurement.menuWidth) <= 1, `back button width ${measurement.backWidth} did not match menu width ${measurement.menuWidth}`);
  } finally {
    await page.close();
  }
});

test("mobile chat header controls stay vertically centered within the header", { timeout: 30_000 }, async () => {
  const page = await openFixturePage("");

  try {
    const measurement = await page.evaluate(() => {
      const header = document.querySelector<HTMLElement>(".chat-head");
      const backButton = document.querySelector<HTMLElement>(".ghost-button--back");
      const menuButton = document.querySelector<HTMLElement>(".chat-head__menu-trigger");
      if (!header || !backButton || !menuButton) {
        throw new Error("Missing chat header controls");
      }

      const headerRect = header.getBoundingClientRect();
      const backRect = backButton.getBoundingClientRect();
      const menuRect = menuButton.getBoundingClientRect();
      return {
        headerCenterY: headerRect.top + headerRect.height / 2,
        backCenterY: backRect.top + backRect.height / 2,
        menuCenterY: menuRect.top + menuRect.height / 2
      };
    });

    assert.ok(
      Math.abs(measurement.backCenterY - measurement.headerCenterY) <= 2,
      `back button center ${measurement.backCenterY} did not align with header center ${measurement.headerCenterY}`
    );
    assert.ok(
      Math.abs(measurement.menuCenterY - measurement.headerCenterY) <= 2,
      `menu button center ${measurement.menuCenterY} did not align with header center ${measurement.headerCenterY}`
    );
  } finally {
    await page.close();
  }
});

test("mobile chat header actions button stays inset from the right edge", { timeout: 30_000 }, async () => {
  const page = await openFixturePage("");

  try {
    const measurement = await page.evaluate(() => {
      const topbar = document.querySelector<HTMLElement>(".chat-topbar");
      const backButton = document.querySelector<HTMLElement>(".ghost-button--back");
      const menuButton = document.querySelector<HTMLElement>(".chat-head__menu-trigger");
      if (!topbar || !backButton || !menuButton) {
        throw new Error("Missing chat header controls");
      }

      const topbarRect = topbar.getBoundingClientRect();
      const backRect = backButton.getBoundingClientRect();
      const menuRect = menuButton.getBoundingClientRect();

      return {
        leftInset: backRect.left - topbarRect.left,
        rightInset: topbarRect.right - menuRect.right
      };
    });

    assert.ok(measurement.rightInset >= 6, `menu right inset ${measurement.rightInset} was too small`);
    assert.ok(
      Math.abs(measurement.leftInset - measurement.rightInset) <= 4,
      `header control insets drifted too far apart (${measurement.leftInset} vs ${measurement.rightInset})`
    );
  } finally {
    await page.close();
  }
});

test("mobile chat keeps the composer inside the chat shell when the app viewport height changes", { timeout: 30_000 }, async () => {
  const page = await openFixturePage(
    `
      <article class="message-row message-row--assistant">
        <div class="message-card message-card--assistant">
          <p>Viewport sync fixture</p>
        </div>
      </article>
    `,
    `
      <div class="composer">
        <div class="composer-input-row">
          <div class="composer-field">
            <textarea rows="1" placeholder="Ask Codex..."></textarea>
            <div class="composer-actions">
              <button class="composer-send" type="button">↑</button>
            </div>
          </div>
        </div>
      </div>
    `
  );

  async function measureWithViewportHeight(height: number) {
    return page.evaluate(async (nextHeight) => {
      document.documentElement.style.setProperty("--app-viewport-height", `${nextHeight}px`);
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });

      const appShell = document.querySelector<HTMLElement>(".app-shell");
      const workspaceShell = document.querySelector<HTMLElement>(".workspace-shell");
      const chat = document.querySelector<HTMLElement>(".workspace-shell__chat");
      const composerField = document.querySelector<HTMLElement>(".composer-field");
      if (!appShell || !workspaceShell || !chat || !composerField) {
        throw new Error("Missing mobile chat viewport fixture");
      }

      return {
        appShellHeight: appShell.getBoundingClientRect().height,
        workspaceShellHeight: workspaceShell.getBoundingClientRect().height,
        chatBottom: chat.getBoundingClientRect().bottom,
        composerBottom: composerField.getBoundingClientRect().bottom
      };
    }, height);
  }

  try {
    const initial = await measureWithViewportHeight(851);
    assert.ok(Math.abs(initial.appShellHeight - 851) <= 1, `app shell height ${initial.appShellHeight} did not follow the synced viewport height`);
    assert.ok(Math.abs(initial.workspaceShellHeight - 851) <= 1, `workspace shell height ${initial.workspaceShellHeight} did not follow the synced viewport height`);
    assert.ok(initial.composerBottom <= initial.chatBottom + 1, `composer bottom ${initial.composerBottom} overflowed chat bottom ${initial.chatBottom}`);

    const resized = await measureWithViewportHeight(640);
    assert.ok(Math.abs(resized.appShellHeight - 640) <= 1, `app shell height ${resized.appShellHeight} did not update after viewport sync`);
    assert.ok(Math.abs(resized.workspaceShellHeight - 640) <= 1, `workspace shell height ${resized.workspaceShellHeight} did not update after viewport sync`);
    assert.ok(resized.composerBottom <= resized.chatBottom + 1, `composer bottom ${resized.composerBottom} overflowed chat bottom ${resized.chatBottom} after viewport resize`);
  } finally {
    await page.close();
  }
});
