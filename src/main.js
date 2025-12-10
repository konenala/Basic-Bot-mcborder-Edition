const fs = require('fs')
const path = require('path')
const readline = require('readline')
const mineflayer = require('mineflayer')
const ResourcePackHandler = require('./utils/ResourcePackHandler')

require('events').EventEmitter.defaultMaxListeners = 0

// --- Path and Config Setup ---
// When packaged with pkg, __dirname points to the snapshot filesystem.
// We need to use process.execPath to find the directory of the actual executable.
const executableDir = path.dirname(process.execPath)
const projectRootDir = path.resolve(__dirname, '..')

console.log('--- [DEBUG] Path Information ---')
console.log(`Executable Directory (executableDir): ${executableDir}`)
console.log(`Current Working Directory (process.cwd()): ${process.cwd()}`)
console.log(`Project Root Directory (projectRootDir): ${projectRootDir}`)
console.log('---------------------------------')

// --- Runtime Configuration Loading ---
// This logic determines the config file path at runtime, preventing pkg from bundling it.
// Priority: 1. CLI argument, 2. Environment variable, 3. Default file next to executable or project/work dir.

/**
 * 解析預設設定檔路徑（支援開發與 pkg 執行檔）
 */
// 解析預設設定檔路徑（依執行環境挑選候選）
function resolveDefaultConfigPath() {
  const candidates = []

  // pkg 版：設定檔放在可寫的執行檔同層
  if (process.pkg) {
    candidates.push(path.join(executableDir, 'config.json'))
  } else {
    // 開發模式：優先專案根，再工作目錄，最後退回執行檔目錄
    candidates.push(path.join(projectRootDir, 'config.json'))
    candidates.push(path.join(process.cwd(), 'config.json'))
    candidates.push(path.join(executableDir, 'config.json'))
  }

  const existing = candidates.find(p => fs.existsSync(p))
  return existing || candidates[0]
}

/**
 * 取得設定檔路徑：CLI > 環境變數 > 預設候選
 */
// 取得設定檔路徑（優先權：CLI > 環境變數 > 預設）
function getConfigPath() {
  // 1. Check for --config=<path> argument
  const arg = process.argv.find(a => a.startsWith('--config='))
  if (arg) {
    return path.resolve(arg.split('=')[1])
  }

  // 2. Check for BOT_CONFIG_PATH environment variable
  if (process.env.BOT_CONFIG_PATH) {
    return path.resolve(process.env.BOT_CONFIG_PATH)
  }

  // 3. Default path based on runtime environment
  return resolveDefaultConfigPath()
}

const configPath = getConfigPath()
let config
try {
  console.log(`[INFO] Attempting to load configuration from: ${configPath}`)
  if (!fs.existsSync(configPath)) {
    throw new Error(`Configuration file 'config.json' not found at: ${configPath}`)
  }
  const configFileContent = fs.readFileSync(configPath, 'utf8')
  config = JSON.parse(configFileContent)
} catch (error) {
  console.error(`[FATAL] Failed to read or parse config file: ${error.message}`)
  process.exit(1) // Exit if config is missing or invalid
}

// 設定檔所在目錄（亦作為 token 快取目錄）
const runtimeDataDir = path.dirname(configPath)

// --- Global Error Handling & Variables ---
process.on('uncaughtException', (err) => {
  console.log('UncoughtError: ' + (err && err.stack ? err.stack : err))
})
let deathCount = 0
let dailyRewardTimer = null
let moneyTransferTimer = null
let lastClaimDate = null
const HEART_SYMBOL = '❤'

// --- Helper Functions ---
// 取得清理後的白名單列表
function getCleanWhitelist() {
  return (config.whitelist || []).map(cleanPlayerName)
}

// 移除玩家名中的括號備註
function cleanPlayerName(username) {
  return username.replace(/\s*\(.+?\)\s*/, '').trim()
}

// 組合 bot 啟動選項（含裝置代碼登入提示與快取目錄）
function buildBotOptions() {
  const opts = {
    host: config.ip,
    port: config.port,
    username: config.username,
    auth: config.auth,
    version: config.version,
    profilesFolder: path.join(runtimeDataDir, '.minecraft'),
    onMsaCode: (data) => {
      console.log(`[MSA] 請於 ${data.verification_uri} 輸入代碼：${data.user_code}，有效期 ${Math.round(data.expires_in / 60)} 分鐘`)
    }
  }
  return opts
}

// --- Main Bot Logic ---
// 啟動 bot 並掛載事件與重連邏輯
async function startBot() {
  const opts = buildBotOptions()
  const bot = mineflayer.createBot(opts)

  // 初始化並立即啟用資源包處理器（1.20.2+ configuration 階段需要）
  const resourcePackHandler = new ResourcePackHandler(bot, {
    autoAccept: true,
    logPackets: true
  })
  resourcePackHandler.enable()
  console.log('[ResourcePack] 資源包自動接受已啟用')

  // ----- Chat bridge (stdin -> game) -----
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false })
  rl.on('line', (line) => {
    try { if (line && line.length) bot.chat(line) } catch (e) { console.error('[RL_CHAT_ERROR]', e) }
  })

  // ----- On spawn -----
  bot.once('spawn', () => {
    console.log('bot已成功啟動!')
    console.log('whitelist:', getCleanWhitelist())
    bot.loadPlugin(require('mineflayer-collectblock').plugin)
    bot.chatAddPattern(/^\[傳送\]\s*(.+?)\s*請求傳送到你這裡（請注意安全）。?$/, 'tpa_to_me', 'TPA請求')
    bot.chatAddPattern(/^\[傳送\]\s*(.+?)\s*請求你傳送到他那裡（請注意安全）。?$/, 'tpa_from_me', 'TPA請求')
    scheduleDailyRewards(bot)

    // --- Hourly Money Transfer Task ---
    const targetPlayer = config.moneyTransferTarget
    if (targetPlayer) {
      // 安全檢查：避免自轉帳
      if (bot.username.toLowerCase() === targetPlayer.toLowerCase()) {
        console.log(`[PAY] Bot's username (${bot.username}) is the same as the payment target. Auto-payment feature is disabled for safety.`)
        return
      }

      if (moneyTransferTimer) clearInterval(moneyTransferTimer) // 清除舊的計時器以防重連時重複
      console.log(`[PAY] 每小時自動轉帳功能已啟用，目標玩家: ${targetPlayer}。`)
      // 首次啟動時先執行一次
      transferMoneyTask(bot)
      // 設定每小時執行一次 (1小時 = 3600000 毫秒)
      moneyTransferTimer = setInterval(() => transferMoneyTask(bot), 3600000)
    } else {
      console.log('[PAY] 未在 config.json 中設定 moneyTransferTarget，自動轉帳功能已停用。')
    }
  })

  // ----- TPA handling -----
  bot.on('tpa_to_me', (player) => {
    const cleanedPlayer = cleanPlayerName(player)
    if (getCleanWhitelist().includes(cleanedPlayer)) {
      bot.chat(`/tpyes ${cleanedPlayer}`)
      console.log(`已接受來自 ${cleanedPlayer} 的TPA請求`)
    } else {
      bot.chat(`/tpno ${cleanedPlayer}`)
      console.log(`已拒絕來自 ${cleanedPlayer} 的TPA請求 (不在白名單)`)
    }
  })

  bot.on('tpa_from_me', (player) => {
    const cleanedPlayer = cleanPlayerName(player)
    if (getCleanWhitelist().includes(cleanedPlayer)) {
      bot.chat(`/tpyes ${cleanedPlayer}`)
      console.log(`已接受來自 ${cleanedPlayer} 的TPA請求`)
    } else {
      bot.chat(`/tpno ${cleanedPlayer}`)
      console.log(`已拒絕來自 ${cleanedPlayer} 的TPA請求 (不在白名單)`)
    }
  })

  // ----- Message handling (commands) -----
  bot.on('message', (jsonMsg) => {
    const text = jsonMsg.toString().trim()
    if (!text) return

    try { if (!text.includes(HEART_SYMBOL)) console.log(text) } catch (e) { console.error('[MSG_LOG_ERROR]', e) }

    // --- Reward Claim Trigger (偵測多種訊息格式) ---
    if (text.includes('[獎勵] 看起來您還沒有領取每日獎勵') ||
        text.includes('[獎勵] 您還沒領取每日獎勵喔') ||
        text.includes('[獎勵] 您還沒領取每日獎勵喔！使用 [/menu] 透過菜單來簽到吧！') ||
        text.includes('使用 [/menu] 透過菜單來簽到吧')) {
      console.log('[REWARD] Detected reminder message, attempting to claim now.');
      claimDailyRewards(bot).catch(err => {
        console.error('[REWARD] Claim failed after reminder:', err)
      });
    }
    // --- End Reward Claim Trigger ---

    const directMsgMatch = text.match(/^\[(.+?)\s*->\s*我\]\s*(.+)$/)
    if (directMsgMatch) {
      const player = cleanPlayerName(directMsgMatch[1])
      const message = directMsgMatch[2].trim()
      if (getCleanWhitelist().includes(player)) {
        const command = message.split(' ')[0]
        if (command === 'dropall') dropAll(bot)
        if (command === 'job') autoJob(bot)
        if (command === 'gorpg') toRpg(bot)
      }
    }
  })

  // ----- Death handling -----
  bot.on('death', async () => {
    await bot.waitForTicks(10)
    deathCount++
    console.log(`已死亡: ${deathCount} 次，且已自動/back返回`)
    try { bot.chat('/back') } catch (e) { console.error('Failed to send /back command after death:', e) }
  })

  // ----- Kick/disconnect debug -----
  bot.on('kicked', (reason) => {
    console.log('被伺服器踢出:', reason)
  })

  bot.on('error', (err) => {
    console.log('發生錯誤:', err)
  })

  // ----- Auto-reconnect -----
  bot.on('end', (reason) => {
    console.log(`連線已中斷: ${reason}, 10秒後將重新連線...`)
    rl.close()
    clearTimeout(dailyRewardTimer)
    clearInterval(moneyTransferTimer)
    setTimeout(startBot, 10000)
  })
}

// --- Actions ---
// 丟出背包所有物品
async function dropAll(bot) {
  console.log('正在丟棄所有物品...')
  for (const item of bot.inventory.items()) {
    try {
      await bot.tossStack(item)
    } catch (e) {
      // ignore errors
    }
  }
  console.log('所有物品已丟棄完畢')
}

// 自動開啟並選擇職業
async function autoJob(bot) {
  console.log('正在自動選擇職業...')
  try {
    bot.chat('/job')
    const menu = await bot.waitForWindow()
    await bot.clickWindow(19, 0, 0) // 點擊礦工
    await bot.waitForTicks(20)
    await bot.clickWindow(40, 0, 0) // 點擊確認
    bot.closeWindow(menu)
    console.log('職業選擇完畢')
  } catch (e) {
    console.error('自動選擇職業失敗:', e)
  }
}

// 切換到 RPG 分流
async function toRpg(bot) {
  console.log('正在前往RPG分流...')
  try {
    bot.chat('/rpg')
    const menu = await bot.waitForWindow()
    await bot.clickWindow(9, 0, 0) // 點擊RPG-1
    await bot.waitForTicks(20)
    await bot.clickWindow(24, 0, 0) // 點擊確認
    bot.closeWindow(menu)
    console.log('已進入RPG分流')
  } catch (e) {
    console.error('前往RPG分流失敗:', e)
  }
}

// 每小時自動轉帳任務
async function transferMoneyTask(bot) {
  const targetPlayer = config.moneyTransferTarget
  try {
    console.log('[PAY] 執行每小時轉帳任務...')
    const amount = await getMoney(bot)

    if (amount !== null && amount > 0) {
      console.log(`[PAY] 查詢到餘額: ${amount}。正在支付給 ${targetPlayer}...`)
      bot.chat(`/pay ${targetPlayer} ${amount}`)
    } else {
      console.log('[PAY] 餘額為0或查詢失敗，本次不執行轉帳。')
    }
  } catch (err) {
    console.error('[PAY] 轉帳任務發生錯誤:', err.message)
  }
}

// 查詢餘額並解析回應訊息
function getMoney(bot) {
  console.log('[MONEY] 正在查詢餘額...')
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      bot.removeListener('message', listener)
      reject(new Error('查詢餘額超時，伺服器沒有回應。'))
    }, 10000) // 10秒超時

    const listener = (jsonMsg) => {
      const message = jsonMsg.toString().trim()
      if (!message) return

      // [偵錯用] 將收到的每一條訊息都印出來，方便我們看到原始資料
      console.log(`[MONEY_DEBUG] Received message: "${message}"`)

      // 最終修正版正規表示式：
      // 1. 使用 [\s:：$]* 避免貪婪匹配問題
      // 2. 使用 ([\d,]+\.?\d*) 來同時支援整數和小數
      const moneyRegex = /(?:餘額|金錢|您目前擁有|money|balance)[\s:：$]*([\d,]+\.?\d*)/i
      const match = message.match(moneyRegex)

      if (match && match[1]) {
        clearTimeout(timeout)
        bot.removeListener('message', listener)
        // 使用 parseFloat 來處理小數，並在轉換前移除所有逗號
        const amount = parseFloat(match[1].replace(/,/g, ''))
        resolve(amount)
      }
    }

    bot.on('message', listener)
    bot.chat('/money')
  })
}

// --- Daily Rewards ---
// 排程每日領獎
function scheduleDailyRewards(bot) {
  if (dailyRewardTimer) clearTimeout(dailyRewardTimer)

  const now = new Date()
  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)
  tomorrow.setHours(1, 1, 0, 0) // 設置為隔天 01:01:00

  const msUntilTomorrow = tomorrow.getTime() - now.getTime()
  console.log(`[REWARD] next schedule in ${Math.round(msUntilTomorrow / 1000)} s`)

  dailyRewardTimer = setTimeout(async () => {
    await claimDailyRewards(bot)
    scheduleDailyRewards(bot) // Schedule for the next day
  }, msUntilTomorrow)

  // Claim now if it hasn't been claimed today
  claimDailyRewards(bot).catch(err => {
    console.error('[REWARD] Initial claim failed:', err)
  })
}

// 執行每日領獎流程
async function claimDailyRewards(bot) {
  const today = new Date().toISOString().slice(0, 10)
  if (lastClaimDate !== today) {
    console.log(`[REWARD] Attempting to claim for ${today}`)
    lastClaimDate = today
    try {
      // 打開 /menu GUI
      bot.chat('/menu')
      console.log('[REWARD] Waiting for menu window...')

      // 使用 Promise 等待窗口打開事件 (兼容所有版本)
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          bot.removeListener('windowOpen', onWindowOpen)
          reject(new Error('Window open timeout'))
        }, 5000)

        const onWindowOpen = (window) => {
          clearTimeout(timeout)
          resolve(window)
        }

        bot.once('windowOpen', onWindowOpen)
      })

      await new Promise(resolve => setTimeout(resolve, 500)) // 等待 GUI 完全載入

      // 第一步: 點擊第3列第5個欄位 (slot 22: row 3, col 5) 打開獎勵頁面
      // 計算: (3-1) * 9 + (5-1) = 18 + 4 = 22
      console.log('[REWARD] Step 1: Clicking slot 22 (row 3, col 5) to open rewards...')
      await bot.clickWindow(22, 0, 0)

      await new Promise(resolve => setTimeout(resolve, 500)) // 等待獎勵頁面打開

      // 第二步: 點擊獎勵頁面中的所有欄位來領取獎勵
      console.log('[REWARD] Step 2: Clicking all slots to claim rewards...')
      const rewardWindow = bot.currentWindow
      if (rewardWindow) {
        // 點擊所有可能的獎勵欄位 (通常是前4-5列，共 36-45 個欄位)
        // Minecraft GUI 標準大小是 6 列 (0-53)，但獎勵通常在前幾列
        for (let slot = 0; slot < 45; slot++) {
          try {
            const item = rewardWindow.slots[slot]
            // 只點擊有物品的欄位
            if (item && item.type !== -1) {
              console.log(`[REWARD] Clicking slot ${slot}...`)
              await bot.clickWindow(slot, 0, 0)
              await new Promise(resolve => setTimeout(resolve, 100)) // 短暫延遲避免過快點擊
            }
          } catch (err) {
            // 忽略個別欄位的錯誤，繼續下一個
          }
        }
      }

      await new Promise(resolve => setTimeout(resolve, 500)) // 等待所有獎勵領取完成

      if (bot.currentWindow) {
        bot.closeWindow(bot.currentWindow)
      }
      console.log(`[REWARD] Successfully claimed for ${today}`)
    } catch (e) {
      console.error('[REWARD] Failed to claim daily rewards:', e)
      // 重置日期以便下次重試
      lastClaimDate = null
    }
  } else {
    console.log(`[REWARD] Already claimed today (${today})`)
  }
}

// --- Graceful Shutdown ---
// 清理資源（保留擴充點）
function cleanup() {
}
process.on('exit', cleanup)
process.on('SIGINT', () => process.exit()) // ctrl-c
process.on('SIGTERM', () => process.exit()) // kill

// --- Start the bot (only when executed directly) ---
if (require.main === module) {
  startBot()
}

// 匯出函式供開發/測試使用
module.exports = {
  startBot,
  getConfigPath,
  resolveDefaultConfigPath
}
