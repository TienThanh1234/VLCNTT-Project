# Điều tra Wokwi chậm và tối ưu firmware

## Kết luận có bằng chứng

Backend đã nhận payload hợp lệ, không drop. Mẫu được cung cấp có `wall_gap_ms=5558`, `device_gap_ms=1005`, tương đương tốc độ thiết bị quan sát khoảng 0,181× thời gian thực. `state_age_ms=5158` nên backend đánh dấu stale đúng theo giới hạn 4000 ms. Command trước đó có ACK đến ở 7924 ms và repeat ở 9692 ms nên backend loại đúng `ack_wall_timeout`. Không tăng timeout và không ép stale=false.

Chưa đủ bằng chứng để quy toàn bộ độ chậm cho network hoặc Wokwi CPU. Firmware trong workspace trước sửa có các nguồn tải/rủi ro sau:

- State, MPU và RPM được phát thành một đợt ba bản tin trước lần `mqtt.poll()` tiếp theo.
- `ArduinoMqttClient` 0.1.8 chờ PUBACK đồng bộ trong `endMessage()` đối với QoS1. ACK phải giữ QoS1; state/telemetry trong workspace dùng QoS0. Ảnh Serial từ Wokwi từng ghi state QoS1, chứng minh firmware đang chạy trong browser khác source workspace.
- Custom motor chip theo dõi PWM 1 kHz, khoảng 2000 cạnh/giây, và chạy callback timer mỗi 1 ms. Đây là tải mô phỏng, không phải nhu cầu của mô hình vật lý thật.
- Một số log Serial nằm ngay đường ACK/output. Serial trong mô phỏng có thể góp thêm tải.

Không có quyền đọc hay nạp trực tiếp project Wokwi đang mở từ môi trường này. Vì vậy thay đổi dưới đây đã được kiểm thử native/cục bộ nhưng chưa được gọi là kiểm chứng Wokwi thật.

## Thay đổi tối thiểu

### `firmware/mqtt_support.h`

- Thêm lịch xoay `state → vibration → rpm`, mỗi stream xấp xỉ 250 ms theo đồng hồ thiết bị khi vòng lặp theo kịp.
- Mỗi vòng chỉ chọn tối đa một telemetry. Lịch đặt lần kế tiếp từ thời điểm thực tế đã phục vụ nên không phát bù dồn sau publish/poll chậm.
- Xoay bắt buộc bảo đảm state không làm đói MPU/RPM khi mỗi vòng mất hơn 250 ms.
- Giữ fresh ACK ưu tiên hơn repeat và telemetry. Repeat chuyển từ 750 lên 1100 ms theo đồng hồ thiết bị để renew một giây có cơ hội được poll trước.
- Thêm bộ đo peak `poll_us`, `tx_us`, `imu_us`, `gap_us`, `aq_ms`.

### `firmware/sketch.ino`

- `mqtt.poll()` chạy trước ACK và telemetry.
- Fresh ACK: mỗi vòng gửi một ACK rồi quay lại poll; không drain cả FIFO trong một vòng. Repeat cũng quay lại poll trước mọi telemetry tiếp theo.
- State/MPU/RPM không còn phát cùng một burst.
- Giữ ACK QoS1. State/MPU/RPM giữ QoS0 như source workspace, nên không chờ PUBACK trong thư viện. Không đổi schema/topic/seq/boot/lease.
- Bật TCP no-delay sau connect cho các gói nhỏ.
- Đo thời gian poll/publish/I²C và tuổi ACK trong queue. Dòng `PERF` tối đa mỗi 5 giây thiết bị và chỉ ghi nếu buffer Serial còn đủ chỗ.
- Log ACK/output thường dùng ghi không chặn; log lỗi kết nối vẫn giữ.
- MPU timestamp được lấy sau khi đọc I²C hoàn tất. Đây vẫn là telemetry đơn legacy, không được coi là dữ liệu FFT 200 Hz.
- Banner mới: `FW cooperative-telemetry-v1 ... state_qos=0 ack_qos=1 telemetry_ms=250` và `SIM PWM 200Hz/8bit` để phân biệt đúng firmware đang chạy.

STOP, lease expiry và PWM output vẫn ở task điều khiển độc lập chu kỳ 10 ms theo đồng hồ thiết bị. MQTT loop có block vẫn không ngăn task này tắt output. Không tự gửi START/PWM trong test.

### `firmware/rg-motor.chip.c`

- PWM mô phỏng giảm 1000 → 200 Hz nhưng giữ 8-bit duty.
- Timer chip giảm 1 → 5 ms. Hệ số quán tính đổi `1/180` → `1/36` và tích phân vòng quay nhân 5, giữ gần cùng time constant 180 ms và RPM steady-state.
- Đây chỉ là custom chip Wokwi. Không phải cấu hình PWM được phê duyệt cho motor/driver thật.

## Cách phân biệt nguyên nhân sau khi nạp đúng source vào Wokwi

Stop rồi Run lại project Wokwi sau khi đồng bộ `sketch.ino`, `mqtt_support.h` và `rg-motor.chip.c`. Không nhấn START trước khi state mới xuất hiện. Serial phải có đúng banner phiên bản nêu trên; nếu vẫn thấy `STATE BROKER_CONFIRMED ... qos=1`, browser vẫn đang chạy source khác.

Đọc vài dòng `PERF` cùng `/api/state`:

- `poll_us`, `tx_us` hoặc `imu_us` lớn theo **device time** chỉ ra thao tác tương ứng chiếm thời gian firmware.
- `aq_ms` là thời gian ACK nằm trong queue trước khi bắt đầu publish; phải nhỏ.
- `gap_us` lớn chỉ ra loop không được chạy đều.
- Backend `wall_gap_ms/device_gap_ms` là tỷ lệ thực tế nhìn từ máy. Nếu các peak device-time nhỏ nhưng tỷ lệ wall/device vẫn thấp, bằng chứng nghiêng về tốc độ mô phỏng/host/browser hoặc chờ gateway không được phản ánh đầy đủ bởi đồng hồ ảo. Không thể tách hai trường hợp cuối chỉ bằng `millis()`.
- `ACK BROKER_CONFIRMED dt_device_ms` chỉ là broker PUBACK theo device time, không phải backend ACK_ACCEPT. Kết quả lệnh vẫn phải kiểm theo command_id tại `/api/commands/:id`.

Tiêu chí kiểm chứng Wokwi thật sau đồng bộ:

1. state tiếp tục tăng, state/MPU/RPM đều có accepted tăng, dropped=0;
2. `state_age_ms < 4000` liên tục trong ít nhất 30 giây wall time;
3. một START thủ công có ACK_ACCEPT và ACK_WS_SEND dưới 5000 ms wall time;
4. renew tiếp tục đến trước lease expiry; STOP và lease expiry vẫn tắt output;
5. không có burst telemetry hoặc `ack_queue_full`.

Chưa thực hiện các mục này trên phiên Wokwi thật vì agent không điều khiển được browser/project của người dùng và không tự phát lệnh motor lên broker công khai.

## Kiểm thử

Thêm test native MSVC cho lịch gửi với publish giả lập chậm 300 ms, công bằng state/MPU/RPM, không catch-up burst, rollover `uint32_t`, ưu tiên fresh ACK, repeat sau renew, lease expiry và STOP khi MQTT loop bị block. Test còn so đáp ứng quán tính cũ/mới trong sai khác dưới 1%.

Test tích hợp backend cục bộ tái tạo chính xác `wall_gap=5158`, `device_gap=1005`: state trở thành stale và chỉ state mới mới xóa stale. Các test ACK 7924/9692 ms, reconnect, duplicate, Start/Stop/renew, FFT 7 Hz/RMS và baseline vẫn được giữ.
