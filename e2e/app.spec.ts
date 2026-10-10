import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { PDFDocument, StandardFonts } from 'pdf-lib'

interface Harness {
  app: ElectronApplication
  page: Page
  errors: string[]
}

async function createFixturePdf(file: string): Promise<void> {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  for (let pageNumber = 1; pageNumber <= 4; pageNumber += 1) {
    const page = document.addPage(pageNumber === 3 ? [720, 480] : [612, 792])
    page.drawText(`koibill smoke document — page ${pageNumber}`, { x: 54, y: page.getHeight() - 72, size: 18, font })
    page.drawText('A deterministic paragraph for rendering, selection, zoom, and semantic reflow.', { x: 54, y: page.getHeight() - 112, size: 11, font })
  }
  await writeFile(file, await document.save())
}

async function launchHarness(): Promise<Harness> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'koibill-e2e-'))
  const profile = path.join(root, 'profile')
  const workspaces = path.join(root, 'workspaces')
  await mkdir(profile, { recursive: true })
  await mkdir(workspaces, { recursive: true })
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ workspaceRoot: workspaces }))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${profile}`],
    env: { ...process.env, KOIBILL_E2E: '1' },
  })
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  await page.setViewportSize({ width: 1280, height: 760 })
  return { app, page, errors }
}

test('isolated workspace, PDF lifecycle, and right-pane smoke', async () => {
  const harness = await launchHarness()
  const { app, page, errors } = harness
  try {
    await expect(page.getByRole('heading', { name: 'Choose a workspace' })).toBeVisible()
    await page.getByPlaceholder('Workspace name').fill('Automated smoke')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    const importButton = page.locator('.tab-import-button')
    await expect(importButton).toBeVisible()

    const root = await mkdtemp(path.join(os.tmpdir(), 'koibill-pdf-'))
    const pdf = path.join(root, 'smoke.pdf')
    await createFixturePdf(pdf)
    await app.evaluate(async ({ dialog }, fixture) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture] })
    }, pdf)
    await importButton.click()
    await expect(page.locator('.pdf-page').first()).toBeVisible({ timeout: 15_000 })

    const readerControls = page.locator('.reader-controls')
    for (let index = 0; index < 4; index += 1) {
      await readerControls.getByRole('button', { name: 'Zoom in' }).click()
      await readerControls.getByRole('button', { name: 'Zoom out' }).click()
    }
    await page.getByRole('button', { name: 'Reflow', exact: true }).click()
    await expect(page.locator('.semantic-reflow')).toBeVisible({ timeout: 15_000 })
    await page.getByRole('button', { name: 'Original', exact: true }).click()

    await page.getByRole('button', { name: 'Notes', exact: true }).click()
    await expect(page.locator('.notes-pane')).toBeVisible()
    await page.getByRole('button', { name: 'Graph', exact: true }).click()
    await expect(page.locator('.graph-pane')).toBeVisible()
    await page.getByRole('button', { name: 'Browser', exact: true }).click()
    await page.getByRole('button', { name: 'Collapse right pane' }).click()
    await expect(page.getByRole('button', { name: 'Expand right pane' })).toBeVisible()
    await page.getByRole('button', { name: 'Expand right pane' }).click()

    await page.reload()
    await expect(page.locator('.pdf-page').first()).toBeVisible({ timeout: 15_000 })
    expect(errors.filter((message) => !/ERR_(ABORTED|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED)/u.test(message))).toEqual([])
  } finally {
    await app.close()
  }
})
