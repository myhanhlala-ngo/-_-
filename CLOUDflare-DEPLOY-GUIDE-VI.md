# Hướng dẫn triển khai Cloudflare Daily Sync V2

## Trước khi làm
- Đã có bảng sao lưu `app_state_backup_20261105`.
- Ảnh đối chiếu cho thấy `backup_check = MATCH`, `rev = 2481`, dung lượng hai bản bằng nhau tại thời điểm kiểm tra.
- Nên thông báo nhóm tạm dừng nhập báo cáo trong thời gian deploy và kiểm tra migration.
- Không xóa database `assy-daily-report`, bảng `app_state` hoặc bảng backup.

## Cập nhật GitHub
1. Tải ZIP và giải nén.
2. Trong repository đang kết nối Cloudflare Pages, cập nhật `public/index.html`.
3. Cập nhật `functions/api/db.js`.
4. Thêm thư mục `functions/api/db/file/` và file `[id].js`.
5. Giữ nguyên các file cấu hình hiện có trừ khi Cloudflare yêu cầu khác.
6. Commit và push để Cloudflare Pages deploy.

## Kiểm tra D1 Binding
Cloudflare Pages > Settings > Bindings:
- Type: D1 database
- Variable name: `DB`
- Database: `assy-daily-report`

Không đổi tên binding.

## R2 cho file đính kèm (cần nếu muốn chia sẻ PDF/ảnh giữa các máy)
1. Tạo R2 bucket (ví dụ `assy-daily-report-files`).
2. Pages project > Settings > Bindings > Add > R2 bucket.
3. Variable name: `REPORT_FILES`.
4. Chọn bucket vừa tạo và lưu.
5. Deploy lại.

Nếu không cấu hình R2, báo cáo và dữ liệu theo ngày vẫn đồng bộ qua D1, nhưng file nhị phân chỉ ở IndexedDB của máy đã tải lên. API sẽ báo rõ 503 khi thiếu R2.

## Kiểm tra sau deploy
Mở `/api/db`. Kết quả phải có:
- `ok: true`
- `storage: "daily-v2"`
- `rev` (giữ revision cũ, không reset về 1)
- `state.days` chứa các ngày báo cáo cũ.

Mở `/api/db?meta=1`, xác nhận `storage: "daily-v2"`.

Trong D1 Studio, chạy:
```sql
SELECT COUNT(*) AS migrated_days FROM report_days;
SELECT name, completed_at FROM report_migrations;
SELECT id, rev, length(state_json) AS legacy_size FROM app_state;
SELECT id, rev, length(state_json) AS backup_size FROM app_state_backup_20261105;
```
Số ngày trong `report_days` phải khớp số ngày trong `state.days` của bản cũ. `app_state` và bảng backup vẫn còn.

## Kiểm thử hai máy
- Máy A mở ngày 05/11 và sửa một ô.
- Máy B mở ngày 04/11 và sửa một ô.
- Lưu cả hai: cả hai ngày phải được giữ.
- Thử cùng sửa một ngày trên hai máy: máy lưu sau nhận cảnh báo xung đột; bản local được lưu trong Lịch sử phiên bản của trình duyệt.

## Rollback
Không xóa các bảng V2. Có thể quay lại deployment cũ nhưng dữ liệu được nhập sau migration nằm ở bảng V2, không tự động ghi ngược vào `app_state`. Trước khi rollback, cần xuất và hợp nhất dữ liệu V2 có kiểm soát.
