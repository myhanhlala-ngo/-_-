# Báo cáo công việc hằng ngày – Cloudflare Pages + D1 (Daily Sync V2)

Bản nâng cấp giữ nguyên giao diện `public/index.html` và database D1 hiện tại. API chuyển dữ liệu từ một JSON lớn trong `app_state` sang:
- `report_days`: một hàng cho mỗi ngày báo cáo, có version riêng.
- `report_meta`: dữ liệu dùng chung ngoài ngày (tasks, settings, danh sách file/ảnh tham chiếu...).
- `report_history`: lịch sử các phiên bản trước của ngày / metadata.
- `report_migrations`: đánh dấu migration đã hoàn tất.

**Không xóa `app_state`.** Bảng cũ được giữ nguyên làm nguồn phục hồi.

## 1. Cloudflare Pages cấu hình

- Build output directory: `public` (nếu dự án đang dùng cấu hình này thì giữ nguyên).
- D1 binding: tên biến phải là `DB`, trỏ tới database hiện tại `assy-daily-report`.
- Giữ nguyên các Secrets/Variables đang dùng, đặc biệt `APP_TOKEN` nếu đã cấu hình.
- Không tạo database mới.

## 2. Cập nhật GitHub

Giải nén ZIP và cập nhật các file trong repository, giữ nguyên cấu trúc:
- `public/index.html`
- `functions/api/db.js`
- `functions/api/db/file/[id].js`

Các thư mục Netlify còn trong gói chỉ để tương thích / lưu tham khảo; Cloudflare Pages sử dụng `functions/`.

## 3. Migration tự động, không phá hủy

Khi bản mới được deploy và lần đầu gọi `/api/db`, API:
1. Tạo các bảng `report_days`, `report_meta`, `report_history`, `report_migrations` nếu chưa có.
2. Đọc `app_state` (id=1), tách `state_json.days` thành từng ngày.
3. Lưu các phần còn lại vào `report_meta`.
4. Giữ nguyên `app_state` và bản sao `app_state_backup_20261105`.
5. Giữ nguyên revision cũ để các tab cũ nhận biết thay đổi.

Migration chạy theo batch và có marker `daily-v2`, có thể gọi lại an toàn nếu đã hoàn tất.

## 4. Cách đồng bộ

Trình duyệt gửi kèm snapshot server gần nhất (`baseState`). API so sánh ba chiều:
- Ngày nào chỉ một người sửa: tự hợp nhất, không xung đột với ngày khác.
- Cùng ngày, cùng bản ghi ngày bị sửa từ hai máy: trả `409` và dữ liệu server mới nhất; bản local của người còn lại được lưu vào Lịch sử phiên bản trên trình duyệt.
- Dữ liệu metadata dùng chung được hợp nhất theo khóa đối với `settings`, `pdfs`, `photos`; phần thay đổi đồng thời không thể tự hợp nhất sẽ được báo xung đột.
- Polling vẫn chạy mỗi 20 giây.

## 5. File đính kèm dùng chung (tùy chọn)

Để PDF/ảnh đính kèm được tải lên và tải xuống giữa các máy, tạo R2 bucket rồi thêm R2 binding:
- Variable name: `REPORT_FILES`
- Bucket: chọn bucket R2 dùng cho báo cáo.

Nếu chưa cấu hình R2, dữ liệu báo cáo D1 vẫn đồng bộ; endpoint file trả về lỗi cấu hình rõ ràng và file cục bộ vẫn ở IndexedDB của trình duyệt. Không đưa nội dung file nhị phân vào D1.

## 6. Kiểm tra sau deploy

Mở:
- `/api/db` → trả `{ ok:true, rev, revision, savedAt, state, storage:"daily-v2" }`
- `/api/db?meta=1` → trả revision hiện tại và `storage:"daily-v2"`.

Sau lần gọi API đầu tiên, D1 Studio phải có các bảng:
- `app_state` (cũ, giữ nguyên)
- `app_state_backup_20261105` (bản sao lưu, giữ nguyên)
- `report_days`
- `report_meta`
- `report_history`
- `report_migrations`

Kiểm tra số ngày đã chuyển:
```sql
SELECT COUNT(*) AS migrated_days FROM report_days;
SELECT name, completed_at FROM report_migrations;
SELECT id, rev, length(state_json) AS legacy_bytes FROM app_state;
```

## 7. Rollback

Nếu cần quay lại:
1. Đưa deployment GitHub trước đó trở lại.
2. Không xóa các bảng V2 hoặc bảng backup.
3. API cũ vẫn đọc `app_state` nguyên bản; các thay đổi được ghi sau migration ở V2 sẽ không tự chảy ngược vào `app_state`, vì vậy trước rollback cần xuất dữ liệu V2 và thực hiện khôi phục có kiểm soát. Không rollback khi người dùng vẫn đang nhập liệu.

## 8. Giới hạn / lưu ý

- Không có hệ thống nào bảo đảm tự hợp nhất hai chỉnh sửa khác nhau trên cùng một ngày nếu cả hai thay đổi cùng trường mà không có quy tắc nghiệp vụ; trường hợp đó được báo xung đột và giữ bản local trong lịch sử trình duyệt.
- Để có lịch sử phía server, `report_history` giữ các bản trước của từng ngày và metadata.
- Cần sao lưu/export D1 trước khi deploy. Không xóa bảng cũ.
