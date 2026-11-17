import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('native firmware scheduler: slow publish remains fair and STOP/lease remain independent', t => {
    const directory = mkdtempSync(join(tmpdir(), 'rg-fw-native-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const vcvars = String.raw`C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat`;
    const source = resolve('tests/native/firmware_schedule_test.cpp');
    const include = resolve('firmware');
    const binary = join(directory, 'firmware_schedule_test.exe');
    const script = join(directory, 'compile-and-run.cmd');
    writeFileSync(script, `@call "${vcvars}" >nul\r\n@cl /nologo /EHsc /std:c++17 /I"${include}" "${source}" /Fe:"${binary}" >nul\r\n@if errorlevel 1 exit /b %errorlevel%\r\n@"${binary}"\r\n`);
    const result = spawnSync('cmd.exe', ['/d', '/c', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('firmware source keeps ACK QoS1, telemetry QoS0 and reduces Wokwi callback load', () => {
    const sketch = readFileSync('firmware/sketch.ino', 'utf8');
    const chip = readFileSync('firmware/rg-motor.chip.c', 'utf8');
    assert.match(sketch, /uint8_t qos = isAck \? 1 : 0/);
    assert.match(sketch, /constexpr uint32_t SIM_PWM_HZ = 200/);
    assert.doesNotMatch(sketch, /while \(ackCount > 0\)/);
    assert.match(sketch, /return; \/\/ Poll again before servicing the next ACK or any telemetry/);
    assert.match(chip, /timer_start\(s->update_timer, 5000, true\)/);
    assert.match(chip, /s->rpm \+= \(target - s->rpm\) \/ 36\.0/);
    assert.match(chip, /s->turns \+= s->rpm \* 5\.0 \/ 60000\.0/);
});
