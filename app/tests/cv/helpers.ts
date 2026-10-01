import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decode } from 'jpeg-js'
import { grayFromRgba, type GrayImage } from '../../src/lib/cv/image'

export const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'cv')

export interface FixtureMeta {
  size: number
  corners?: number[][]
  cells?: string
}

export function loadFixture(name: string): { image: GrayImage; meta: FixtureMeta } {
  const jpeg = decode(readFileSync(join(FIXTURE_DIR, `${name}.jpg`)), { useTArray: true })
  const image = grayFromRgba(jpeg.data, jpeg.width, jpeg.height)
  const meta = JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf8')) as FixtureMeta
  return { image, meta }
}

export function loadManifest(): string[] {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8')) as string[]
}
