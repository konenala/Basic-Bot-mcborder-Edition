# 基礎bot_邊境 使用說明

> 適用環境：Windows（PowerShell），Node.js 18+（開發）、pkg 打包執行檔（node18-win-x64）。  
> 登入方式：mineflayer 內建 Microsoft 裝置代碼登入（會在終端顯示驗證網址與代碼）。  

## 1. 專案概觀
- Mineflayer 自動化機器人，支援 Microsoft / 離線登入。
- 主要功能：聊天橋接、TPA 白名單、自動每日領獎、自動職業選擇、RPG 分流切換、自動轉帳、死亡 / 斷線自動處理與重連、資源包自動接受。
- 設定檔與登入快取皆放在執行檔或專案同層（避免寫入系統目錄）。

## 2. 目錄結構
- `src/main.js`：核心程式。
- `config.json`：執行設定（需自行填入）。
- `node_modules/`：套件。
- `dist/bot.exe`：pkg 打包產物（如已執行 `npm run build`）。
- `.minecraft/`：登入 token 快取（首次裝置代碼登入後自動建立）。

## 3. 設定檔 `config.json`
```jsonc
{
  "ip": "mcborder.com",
  "port": 25565,
  "version": "1.21.8",
  "username": "你的微軟帳號@email.com",
  "auth": "microsoft",          // microsoft 或 offline
  "language": "zh-tw",
  "whitelist": ["Konenala21"],
  "moneyTransferTarget": "Konenala21"
}
```
> 路徑優先序：`--config=<path>` > 環境變數 `BOT_CONFIG_PATH` > 預設（pkg: 執行檔同層；開發: 專案根 / 工作目錄）。

## 4. 安裝與開發模式執行
```powershell
cd /mnt/e/bot編寫/基礎bot_邊境   # 或對應 Windows 路徑
npm install
npm start
```
首次登入會顯示：
```
[MSA] 請於 https://microsoft.com/link 輸入代碼：XXXX-XXXX，有效期 N 分鐘
```
在瀏覽器輸入代碼授權後，token 會存到 `.minecraft/`，後續自動使用。

## 5. pkg 打包與執行
```powershell
npm run build          # 產生 dist/bot.exe
```
部署時將 `dist/bot.exe` 與 `config.json` 同層放置即可；登入快取同樣會寫在同層 `.minecraft/`。

## 6. 常用指令（遊戲內私訊觸發）
- `dropall`：丟出所有物品（無保護清單）。
- `job`：開啟職業菜單並選擇預設職業。
- `gorpg`：切換到 RPG 分流。
> 只有在 `whitelist` 內的玩家私訊才會觸發。

## 7. 主要行為
- **TPA 白名單**：符合白名單才接受 `/tpyes`，否則 `/tpno`。
- **每日獎勵**：開服後立即嘗試領取，並排程每日 01:01 自動領取。
- **自動轉帳**：若設定 `moneyTransferTarget`，每小時查餘額並轉出。
- **自動重連**：被斷線後 10 秒嘗試重連。
- **資源包**：自動接受並列印封包除錯資訊（1.20.2+ configuration 階段支援）。

## 8. 故障排查
- **無法讀取設定**：確認 `config.json` 路徑（優先序見上），或使用 `--config=路徑`。
- **登入失敗**：重新執行程式並依提示輸入新的裝置代碼；若需重置，刪除同層 `.minecraft/` 後重啟。
- **被踢/逾時**：查看終端輸出的 `=== KICKED ===` / `=== DISCONNECT PACKET ===` 訊息。

## 9. 開發提示
- 需 PowerShell 相容命令；打包目標為 `node18-win-x64`。
- 重要變數與函式已有中文註解，可直接參閱 `src/main.js`。 
