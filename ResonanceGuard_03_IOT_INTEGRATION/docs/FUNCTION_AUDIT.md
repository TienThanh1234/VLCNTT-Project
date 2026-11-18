# Audit F01–F12 (2026-11-17)

Đầu vào: yêu cầu F01–F12 người dùng cung cấp. Chưa tìm thấy báo cáo `VLCNTT (3)(4).pdf`; PDF có tên `Used_For_Structure_References_Only` không được coi là bản báo cáo nghiệm thu.

| Chức năng | Hiện trạng trước sửa | Thiếu sót | File/nhóm sửa | Tiêu chí nghiệm thu |
|---|---|---|---|---|
| F01 | Telemetry đơn Wokwi | FIFO 200 Hz, timestamp, chất lượng | firmware physical, physical-protocol | Block 20–40 XYZ, reject lỗi; đo Fs và 1g thực |
| F02 | Xung mô hình PPR=1 | PPR, RPM physical, stopped/unknown | firmware physical, protocol | 10 vòng tay, timeout, period/RPM nhất quán |
| F03 | START trực tiếp, lease 4s | ARM, session, nonce | app, control, firmware | ACK ARM trước START; lease ≤2s; reject replay |
| F04 | STOP/lease Wokwi | Khóa bảo vệ physical, broker riêng | firmware, app, deployment docs | Fault/network/reset OFF, không tự chạy lại |
| F05 | Schema synthetic v1 | Contract physical | physical-protocol, app | Unit/range/boot/seq/retain/stale/gap tests |
| F06 | FFT rời, biểu đồ đơn | Block MQTT → giám sát | spectrum, app, dashboard | Mean removal, RMS/peak, age/quality |
| F07 | Một cửa sổ ringdown | Phiên 5–10s, 5 phép đo, time-domain | analysis, storage, API | Known signal, gap/SNR rejection, null thiếu dữ liệu |
| F08 | Chưa triển khai | Sweep, RPM matching, fit 1× | analysis, storage, dashboard | 4 trạng thái, hai phía đỉnh, sweep lên/xuống |
| F09 | Baseline JSON một cửa sổ | Baseline bất biến A–B–A | analysis, storage, API | ≥5 phép đo, max(3s,u_min), hysteresis |
| F10 | Dashboard Wokwi | Physical labels, runs/compare | web/src | ACK ≠ quay, STOP luôn có, khóa START |
| F11 | RAM 240 events + JSONL | SQLite/migrations/raw phiên/replay | storage, API | Lịch sử sau restart, export/replay |
| F12 | Chưa triển khai | Auth/roles; cloud tùy chọn | Tài liệu | Chỉ thực hiện khi F01–F11 ổn định |

Contract v2: measured/physical; v1 chỉ synthetic. Topic state, availability, ack, telemetry/rpm, telemetry/vibration, telemetry/vibration_block và cmd/motor. Block dùng microsecond monotonic 64-bit, XYZ m/s², 5000 µs/sample, quality gồm 5 cờ boolean. `seq` là sequence envelope; `block_seq` tăng riêng cho block. Run/config ID được chốt bằng lệnh cấu hình acquisition chỉ khi motor OFF. Không dùng thời gian nhận MQTT làm thời gian lấy mẫu.
