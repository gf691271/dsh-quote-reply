import { test, expect } from '@playwright/test';

const HARNESS = new URL('./harness.html', import.meta.url).href;
const MESSAGE = new URL('./message.html', import.meta.url).href;

/** Select a whole paragraph the way a user drag would, then let the plugin scan. */
async function selectParagraph(page, id) {
  await page.evaluate((targetId) => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById(targetId));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('pointerup', { bubbles: true }));
  }, id);
}

test.beforeEach(async ({ page }) => {
  await page.goto(HARNESS);
  await expect(page.locator('#seat')).toBeVisible();
});

test('selecting text floats the 引用文本 pill beside the first line', async ({ page }) => {
  await selectParagraph(page, 'passage');
  const pill = page.locator('.dqr-pill');
  await expect(pill).toBeVisible();
  await expect(pill).toHaveText('引用文本');

  const passage = await page.locator('#passage').boundingBox();
  const box = await pill.boundingBox();
  // Above the line when there is room, below it otherwise — never overlapping.
  const above = box.y + box.height <= passage.y + 1;
  const below = box.y >= passage.y + passage.height - 1;
  expect(above || below).toBe(true);
  // horizontally centred on the first line of the selection
  const pillCentre = box.x + box.width / 2;
  expect(Math.abs(pillCentre - (passage.x + passage.width / 2))).toBeLessThan(passage.width / 2);
});

test('a real mouse drag selects and still shows the pill', async ({ page }) => {
  const passage = await page.locator('#passage').boundingBox();
  await page.mouse.move(passage.x + 4, passage.y + 9);
  await page.mouse.down();
  await page.mouse.move(passage.x + 220, passage.y + 9, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator('.dqr-pill')).toBeVisible();
});

test('the popover replies, stacks a square block and sends one message', async ({ page }) => {
  await selectParagraph(page, 'passage');
  await page.locator('.dqr-pill').click();

  const popover = page.locator('.dqr-pop');
  await expect(popover).toBeVisible();
  await expect(popover).toContainText('Claude');

  await page.locator('.dqr-input').fill('浏览器里的回复');
  await page.locator('.dqr-sendicon').click();

  const tile = page.locator('.dqr-tile').first();
  await expect(tile).toBeVisible();
  const box = await tile.boundingBox();
  expect(Math.abs(box.width - box.height)).toBeLessThanOrEqual(2);
  await expect(page.locator('.dqr-strip')).toContainText('发送');

  // type beside the block, then send through the strip button
  await page.locator('#seat').click();
  await page.keyboard.type('手打的一句话');
  await page.locator('.dqr-send').click();

  await expect(page.locator('.dqr-tile')).toHaveCount(0);
  await expect(page.locator('#seat')).toHaveText('');
  const prompted = await page.evaluate(() => window.__prompted);
  expect(prompted).toHaveLength(1);
  expect(prompted[0].mode).toBe('queue');
  expect(prompted[0].content[0].text).toBe(
    '│ 第一段：Claude 里选中文字会浮出「引用文本」，点开就能写回复。\n浏览器里的回复\n\n手打的一句话',
  );
});

test('Enter in the reply box adds a block without sending', async ({ page }) => {
  await selectParagraph(page, 'passage');
  await page.locator('.dqr-pill').click();
  await page.locator('.dqr-input').fill('回车加入');
  await page.locator('.dqr-input').press('Enter');
  await expect(page.locator('.dqr-tile')).toHaveCount(1);
  expect(await page.evaluate(() => window.__prompted)).toHaveLength(0);
  expect(await page.evaluate(() => window.__submits)).toBe(0);
});

test('a streaming scroll keeps the pill, an off-screen selection drops it', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 420 });
  // give the document room to scroll, the way a long transcript has it
  await page.evaluate(() => {
    const filler = document.createElement('div');
    filler.style.height = '1600px';
    document.getElementById('chat').appendChild(filler);
  });
  await selectParagraph(page, 'passage');
  await expect(page.locator('.dqr-pill')).toBeVisible();

  await page.evaluate(() => window.scrollBy(0, 40));
  await page.waitForTimeout(150);
  await expect(page.locator('.dqr-pill')).toBeVisible();

  await page.evaluate(() => window.scrollTo(0, 1200));
  await page.waitForTimeout(250);
  await expect(page.locator('.dqr-pill')).toHaveCount(0);
});

test('the pill survives a locale switch', async ({ page }) => {
  await page.evaluate(() => document.documentElement.setAttribute('lang', 'en'));
  await selectParagraph(page, 'passage');
  await expect(page.locator('.dqr-pill')).toBeVisible();
});

test('the transcript draws a real rule, and only beside quotes', async ({ page }) => {
  await page.goto(MESSAGE);
  const quote = page.locator('.dqr-msg-quote').first();
  await expect(quote).toBeVisible();
  const metrics = await quote.evaluate((element) => {
    const style = getComputedStyle(element);
    return { border: style.borderLeftWidth, display: style.display, padding: style.paddingLeft };
  });
  expect(metrics.border).toBe('2px');
  expect(metrics.display).toBe('inline-block');
  expect(metrics.padding).toBe('10px');
  // the reply line must not carry the rule
  const reply = page.locator('.dqr-msg-quote + span').first();
  expect(await reply.evaluate((element) => getComputedStyle(element).borderLeftWidth)).toBe('0px');
});
