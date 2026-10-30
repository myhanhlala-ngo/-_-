# 조립팀 일일 업무 보고 – Báo cáo công việc hằng ngày (Netlify)

Trang báo cáo ngày của Tổ lắp ráp, chạy online trên Netlify với **cơ sở dữ liệu dùng chung**:
mọi người mở cùng một đường link sẽ thấy cùng một số liệu, ai sửa thì người khác tự nhận bản mới.

```
├── public/
│   └── index.html            ← trang báo cáo (toàn bộ giao diện + chức năng)
├── netlify/
│   └── functions/
│       └── db.mjs            ← API lưu dữ liệu: /api/db (Netlify Blobs)
├── netlify.toml              ← cấu hình Netlify
├── package.json              ← thư viện @netlify/blobs
└── README.md
```

---

## 1. Đưa lên Netlify

> ⚠️ **Không dùng kéo-thả thư mục (Netlify Drop)** – cách đó chỉ đưa lên trang tĩnh, **không chạy được `db.mjs`**,
> nên dữ liệu sẽ không dùng chung được. Hãy dùng 1 trong 2 cách dưới.

### Cách A – Qua GitHub (khuyên dùng, tự cập nhật khi sửa file)
1. Tạo repository mới trên GitHub, tải toàn bộ nội dung thư mục này lên (giữ nguyên cấu trúc).
2. Vào <https://app.netlify.com> → **Add new site → Import an existing project → GitHub** → chọn repository.
3. Netlify tự đọc `netlify.toml`, không cần điền gì thêm → **Deploy**.

### Cách B – Bằng Netlify CLI trên máy tính
```bash
npm install
npx netlify login
npx netlify init          # tạo site mới (lần đầu)
npx netlify deploy --prod
```

---

## 2. Đặt mật khẩu truy cập (nên làm)

Netlify → **Site configuration → Environment variables → Add a variable**

| Key         | Value                    |
|-------------|--------------------------|
| `APP_TOKEN` | mật khẩu bạn tự đặt      |

Sau đó vào **Deploys → Trigger deploy** để áp dụng.
Lần đầu mở trang, mỗi người nhập mật khẩu một lần (trình duyệt sẽ ghi nhớ).
Không đặt `APP_TOKEN` thì ai có link cũng xem / sửa được.

---

## 3. Chuyển dữ liệu cũ lên server (làm 1 lần)

1. Mở trang Netlify vừa tạo.
2. Bấm **Khôi phục từ file sao lưu** → chọn file `조립팀_일일업무보고.html` bạn đang dùng
   (hoặc file `.json` sao lưu) → **Khôi phục**.
3. Thanh trên cùng hiện **☁ Đã đồng bộ server** là xong – mọi người mở link đều thấy dữ liệu này.

---

## 4. Cách hoạt động

| Việc | Diễn ra thế nào |
|---|---|
| Lưu | Mỗi lần sửa, dữ liệu tự lưu trên máy **và** gửi lên server sau ~1 giây |
| Nhận bản mới | Mỗi 20 giây trang kiểm tra server; có bản mới của người khác thì tự tải về (không làm gián đoạn khi bạn đang gõ) |
| Hai người cùng sửa | Người lưu sau sẽ nhận bản mới nhất của server; bản của mình được giữ trong **Lịch sử phiên bản** để lấy lại nếu cần |
| PDF đính kèm | Lưu lên server (tối đa 5,5 MB / file), người khác mở xem được |
| Mất mạng | Vẫn nhập bình thường, lưu trên máy; có mạng lại sẽ tự gửi lên |
| Trạng thái | Góc phải thanh trên: ☁ Đã đồng bộ / Đang lưu / Lỗi / Ngoại tuyến |

Server tự giữ thêm một bản sao lưu sau mỗi 20 lần lưu (Netlify → **Blobs → assy-daily-report → backup/…**).

Mở `public/index.html` trực tiếp trên máy (không qua Netlify) vẫn dùng được đầy đủ, chỉ là dữ liệu lưu riêng trên máy đó.

---

## 5. API (cho người kỹ thuật)

| Method | Đường dẫn | Mô tả |
|---|---|---|
| GET | `/api/db` | `{ ok, rev, savedAt, state }` – toàn bộ dữ liệu |
| GET | `/api/db?meta=1` | `{ ok, rev, savedAt }` – kiểm tra nhanh có bản mới không |
| PUT | `/api/db` | body `{ state, baseRev }` – lưu; trả **409** nếu `baseRev` đã cũ |
| GET / PUT / DELETE | `/api/db/file/:id` | file PDF đính kèm |

Có `APP_TOKEN` thì mọi request phải gửi header `x-app-token`.
Dữ liệu nằm trong Netlify Blobs, store `assy-daily-report`, key `state`.
