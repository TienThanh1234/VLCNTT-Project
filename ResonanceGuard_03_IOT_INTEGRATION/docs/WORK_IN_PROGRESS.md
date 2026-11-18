# Điểm tiếp tục — 2026-11-18

## Yêu cầu đang thực hiện
Hoàn thiện F01–F12 theo yêu cầu người dùng trong attachment `20b73663-d726-4519-9050-64b1b1ae789a/Pasted text.txt`. Không commit, push, deploy. Báo cáo đúng: `C:/Users/admin/Downloads/VLCNTT (3).pdf`, đã trích đọc toàn bộ Chương 2. Bản trích tạm ở root `.tmp-report.txt`, công cụ `.tmp-pdf-tools/`; không đưa các tệp tạm này lên GitHub.

Pinout yêu cầu mới ưu tiên hơn báo cáo: PWM25 AIN1=27 AIN2=26 STBY33, I2C19/23, TACH17, phản hồi DPST32. MPU INT không nối. Không cấp công suất khi chưa lắp bảo vệ.

## Đã viết, chưa nghiệm thu đầy đủ
- `server/physical-protocol.js`: schema v2 measured/physical, RPM, XYZ block và lỗi theo trường; protocol.js giữ v1 synthetic.
- `server/physical-control.js`: ARM/START/renew, nonce thiết bị, owner WebSocket, heartbeat, lease ≤2s, broker LAN có xác thực và xác nhận ACL.
- `server/storage.js`: SQLite node:sqlite, bảng/migration, JSONL theo run, cấu hình, phân tích, baseline/compare. Chưa kiểm thử đầy đủ restart và luồng phiên.
- `server/analysis.js`: free decay/FFT/time domain, fit 1×, bốn trạng thái sweep, baseline. F08 phải kiểm reference, giả định lực, hai lượt lên/xuống; A1/ω² và A1/ω⁴ tách riêng. Ngưỡng thực nghiệm cần kiểm chứng.
- `server/app.js`, `index.js`, `spectrum.js`: nối MQTT physical, API phiên/config/baseline/compare, broker credentials.
- `firmware/physical/ResonanceGuard_ESP32_F01_F05/ResonanceGuard_ESP32_F01_F05.ino`: firmware một file, FIFO/queue/safety task, mặc định khóa công suất. CHƯA COMPILE hay chạy ESP32.
- `web/src/main.jsx`, `control.js`: ARM ACK trước START, heartbeat 500ms, chặn renew khi đang chờ ACK. Cần kiểm tra nhãn tiếng Việt (script sửa có thể chưa khớp chuỗi), bổ sung Runs/Compare.
- `tests/physical.test.js`: RPM, decay 7Hz, control nonce/ARM/rejection unit tests.

## Lệnh đã chạy
- `npm test` trong sandbox: FAIL do spawn EPERM; chạy lại ngoài sandbox: PASS 18/18.
- `npm run build`: PASS.
- `npm run smoke:local`: PASS (backend/Vite/WS/Aedes và peer synthetic; không phải ESP32/browser rendering).
- Không tìm thấy arduino-cli trong PATH; chưa xác minh biên dịch Arduino core 3.x.

## Việc cần làm tiếp theo, theo thứ tự
1. Review safety correctness trước khi mở rộng: firmware dùng JsonDocument/String trong critical section; phải bỏ cấp phát/blocking khỏi mux. Kiểm ArduinoMqttClient beginWill API và ledc core3, kiểm lỗi tạo task/queue/PWM. Không bật PROTECTION_INSTALLED/BROKER_ACL_VERIFIED/TACH_CALIBRATED khi chưa có bằng chứng.
2. Contract freshness/replay: state physical còn thiếu chống stale clock; availability LWT có sequence cũ; phải không bỏ offline vì seq. `accepted` đang cập nhật trước kiểm nonce/block nên cần sửa atomic validation. Bổ sung reorder buffer hữu hạn theo báo cáo. Có thể dùng strict ordered rejection tạm nhưng phải ghi PARTIAL.
3. F01 timestamp hiện tái dựng theo 5000µs, có log Fs độc lập 30s nhưng chưa hiệu chỉnh effective cadence. Run đổi giữa block có thể cần flush; quality ban đầu và mất queue phải kiểm thử.
4. F07: cắt va chạm/đoạn SNR tốt, không hard-code nominal cadence khi cần Fs hiệu dụng. F08: kiểm ổn định biên độ, thứ tự nấc và đủ 20 chu kỳ; test cả bốn trạng thái, không suy supported từ RPM/RMS.
5. F09: test A–B–A, sai config, immutable baseline, poor repeatability, dữ liệu invalid trong tập không được bị bỏ qua khiến vẫn kết luận. Báo tỷ lệ false positive/miss với mẫu số thực.
6. SQLite: test restart/backend process, raw export/replay, error writes và run interruption. Đảm bảo raw trước lọc, metadata đầy đủ và version lịch sử không ghi đè. Bound replay để tránh đọc vô hạn.
7. Dashboard Runs/Compare, bảng nấc/đường đáp ứng, QualityBadge, RMS/peak/age 5–10Hz. Legacy spectrum baseline hiện một cửa sổ, phải phân biệt với baseline F09; bỏ nhãn RESONANCE_ALERT gây hiểu nhầm.
8. Test Aedes v2 end-to-end ARM/configure/blocks/ACK/session/nonce/reconnect/stale; UI asynchronous tests và browser nếu có công cụ. Tests hiện PASS không bao phủ phần lớn code mới.
9. Viết hướng dẫn broker Mosquitto auth/ACL, chạy backend/frontend, nạp Arduino, checklist thiết bị thực; cập nhật audit DONE/PARTIAL/HARDWARE NOT VERIFIED trung thực. F12 chưa triển khai, ưu tiên sau F01–F11.

Không tự đánh dấu phần cứng PASS. Hiện F01–F11 đều PARTIAL hoặc HARDWARE NOT VERIFIED; F12 NOT IMPLEMENTED.
