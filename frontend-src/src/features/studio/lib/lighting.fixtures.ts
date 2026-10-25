/**
 * 生成前后端共享的灯光短语用例：npx tsx src/lib/lighting.fixtures.ts
 * 输出 tests/fixtures/lighting_cases.json，tests/test_lighting.py 用它校验 Python 版 lighting_phrase 与前端逐字一致。
 */
import { writeFileSync } from "node:fs";
import type { Camera, Lighting } from "../types";
import { LIGHT_PRESETS, lightingPhrase, presetLighting } from "./lighting";

const cam = (orbit: number, pitch: number, enabled = true): Camera =>
  ({ enabled, orbit, pitch, roll: 0, distance: 1, fov: 50, pan_x: 0, pan_y: 0, pan_z: 0 }) as Camera;
const cams: (Camera | null)[] = [null, cam(0, 0), cam(-40, 18), cam(95, -25), cam(180, 0), cam(30, 60, false)];

const cases: { name: string; lighting: Lighting; camera: Camera | null; zh: string; en: string }[] = [];
const strip = (lg: Lighting): Lighting => ({ ...lg, lights: lg.lights.map((l, i) => ({ ...l, id: `t${i}` })) });

for (const p of LIGHT_PRESETS) {
  for (const [ci, c] of cams.entries()) {
    if (ci > 2 && !["rembrandt", "rim", "neon", "window", "split"].includes(p.id)) continue;
    const lg = strip(presetLighting(p.id, c ?? undefined));
    cases.push({ name: `${p.id}@${ci}`, lighting: lg, camera: c, zh: lightingPhrase(lg, c, true), en: lightingPhrase(lg, c, false) });
  }
}
// 手动改过的灯：预设失配、彩色、跟随机位、补充描述、关掉的灯
const base = strip(presetLighting("three_point", cam(-40, 18)));
const custom: [string, Lighting, Camera | null][] = [
  ["custom-color", { ...base, preset: "three_point", lights: base.lights.map((l, i) => (i === 2 ? { ...l, kelvin: null, color: "#20c8ff", intensity: 0.9 } : l)) }, cam(-40, 18)],
  ["custom-moved", { ...base, lights: base.lights.map((l, i) => (i === 0 ? { ...l, azimuth: l.azimuth + 70, elevation: 65, softness: 0.05 } : l)) }, cam(-40, 18)],
  ["custom-follow", { ...base, follow: true, preset: "", lights: base.lights.map((l) => ({ ...l, azimuth: l.azimuth + 40 })) }, cam(-40, 18)],
  ["custom-note", { ...base, preset: "", note: "雨水反光，空气里有薄雾", extras: ["haze", "wet"] }, cam(10, 5)],
  ["custom-off", { ...base, preset: "", lights: base.lights.map((l, i) => ({ ...l, enabled: i === 1 })) }, null],
  ["custom-warm-cool", { ...base, preset: "", ambient: 0.05, ambient_kelvin: 9000, lights: [{ ...base.lights[0], kelvin: 1900, intensity: 1.6 }, { ...base.lights[1], kelvin: 10000, intensity: 0.15, softness: 1 }] }, cam(0, 0)],
  ["custom-magenta-under", { ...base, preset: "", lights: [{ ...base.lights[0], azimuth: 0, elevation: -60, kelvin: null, color: "#ff2e88" }] }, cam(0, 0)],
  ["disabled", { ...base, enabled: false }, cam(0, 0)],
];
for (const [name, lg, c] of custom) cases.push({ name, lighting: lg, camera: c, zh: lightingPhrase(lg, c, true), en: lightingPhrase(lg, c, false) });

const presets = LIGHT_PRESETS.map((p) => ({ id: p.id, camera: cam(-40, 18), lighting: strip(presetLighting(p.id, cam(-40, 18))) }));
writeFileSync(new URL("../../tests/fixtures/lighting_cases.json", import.meta.url), JSON.stringify({ cases, presets }, null, 1));
console.log(`wrote ${cases.length} phrase cases, ${presets.length} presets`);
