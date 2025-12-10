/**
 * 資源包自動處理模組
 * 自動接受伺服器發送的資源包請求
 */

class ResourcePackHandler {
  constructor(bot, options = {}) {
    this.bot = bot
    this.options = {
      autoAccept: true, // 自動接受資源包
      logPackets: true, // 記錄資源包請求
      ...options
    }

    this.packetHistory = []
    this.isEnabled = false
  }

  /**
   * 啟用資源包自動接受功能
   */
  enable() {
    if (this.isEnabled) {
      console.log('[ResourcePack] 已經啟用')
      return
    }

    console.log('[ResourcePack] 正在註冊資源包事件監聽器...')

    // 1.20.3+ 使用 add_resource_pack
    this.bot._client.on('add_resource_pack', (packet) => {
      console.log('[ResourcePack] ⚡ 捕獲到 add_resource_pack 封包（1.20.3+）！')
      this.handleResourcePackRequest(packet)
    })

    // 舊版本使用 resource_pack_send
    this.bot._client.on('resource_pack_send', (packet) => {
      console.log('[ResourcePack] ⚡ 捕獲到 resource_pack_send 封包（舊版）！')
      this.handleResourcePackRequest(packet)
    })

    this.isEnabled = true
    console.log('[ResourcePack] 資源包自動接受已啟用')
    console.log('[ResourcePack] 已註冊事件: add_resource_pack (1.20.3+), resource_pack_send (舊版)')
  }

  /**
   * 停用資源包自動接受功能
   */
  disable() {
    if (!this.isEnabled) {
      console.log('[ResourcePack] 已經停用')
      return
    }

    this.bot._client.removeAllListeners('resource_pack_send')
    this.isEnabled = false
    console.log('[ResourcePack] 資源包自動接受已停用')
  }

  /**
   * 處理資源包請求
   */
  handleResourcePackRequest(packet) {
    if (this.options.logPackets) {
      console.log('[ResourcePack] 收到資源包請求:')
      console.log(`  URL: ${packet.url || 'N/A'}`)
      console.log(`  Hash: ${packet.hash || 'N/A'}`)
      console.log(`  Forced: ${packet.forced || false}`)
      console.log(`  Prompt Message: ${packet.promptMessage || 'N/A'}`)
    }

    // 記錄到歷史
    this.packetHistory.push({
      timestamp: Date.now(),
      url: packet.url,
      hash: packet.hash,
      forced: packet.forced,
      promptMessage: packet.promptMessage
    })

    // 保持最多10條歷史記錄
    if (this.packetHistory.length > 10) {
      this.packetHistory.shift()
    }

    if (this.options.autoAccept) {
      // 使用 setImmediate 確保在下一個事件循環中處理
      // 這樣可以避免某些插件（如 Nexo）的時序問題
      setImmediate(() => {
        this.acceptResourcePack(packet)
      })
    }
  }

  /**
   * 接受資源包
   */
  acceptResourcePack(packet) {
    try {
      // 1.20.3+ 使用 resource_pack_status，需要包含 uuid
      // 狀態代碼:
      // 0 - successfully_loaded (成功載入)
      // 1 - declined (拒絕)
      // 2 - failed_download (下載失敗)
      // 3 - accepted (已接受)
      // 4 - downloaded (已下載)
      // 5 - invalid_url (無效URL)
      // 6 - failed_reload (重載失敗)
      // 7 - discarded (已丟棄)

      console.log('[ResourcePack] 📥 處理資源包請求 (1.20.3+)')

      const uuid = packet.uuid || packet.UUID

      // 步驟 1: 發送 accepted (已接受)
      this.bot._client.write('resource_pack_receive', {
        uuid: uuid,
        result: 3 // 3 = accepted
      })
      console.log('[ResourcePack] ✓ 已接受資源包')

      // 步驟 2: 發送 downloaded (已下載)
      setTimeout(() => {
        try {
          this.bot._client.write('resource_pack_receive', {
            uuid: uuid,
            result: 4 // 4 = downloaded
          })
          console.log('[ResourcePack] ✓ 資源包下載完成')

          // 步驟 3: 發送 successfully_loaded (成功載入)
          setTimeout(() => {
            try {
              this.bot._client.write('resource_pack_receive', {
                uuid: uuid,
                result: 0 // 0 = successfully_loaded
              })
              console.log('[ResourcePack] ✅ 資源包載入完成')
            } catch (error) {
              console.error('[ResourcePack] 發送載入完成狀態失敗:', error.message)
            }
          }, 50) // 50ms 延遲
        } catch (error) {
          console.error('[ResourcePack] 發送下載完成狀態失敗:', error.message)
        }
      }, 50) // 50ms 延遲

    } catch (error) {
      console.error('[ResourcePack] 接受資源包時發生錯誤:', error.message)
      console.error('[ResourcePack] 封包內容:', JSON.stringify(packet, null, 2))
    }
  }

  /**
   * 拒絕資源包
   */
  declineResourcePack() {
    try {
      this.bot._client.write('resource_pack_receive', {
        result: 1 // 1 = Declined (拒絕)
      })
      console.log('[ResourcePack] ❌ 已拒絕資源包')
    } catch (error) {
      console.error('[ResourcePack] 拒絕資源包時發生錯誤:', error.message)
    }
  }

  /**
   * 報告下載失敗
   */
  reportDownloadFailed() {
    try {
      this.bot._client.write('resource_pack_receive', {
        result: 2 // 2 = Failed download (下載失敗)
      })
      console.log('[ResourcePack] ⚠️ 已報告資源包下載失敗')
    } catch (error) {
      console.error('[ResourcePack] 報告下載失敗時發生錯誤:', error.message)
    }
  }

  /**
   * 獲取資源包請求歷史
   */
  getHistory() {
    return this.packetHistory
  }

  /**
   * 獲取最後一次資源包請求
   */
  getLastRequest() {
    return this.packetHistory[this.packetHistory.length - 1] || null
  }

  /**
   * 清除歷史記錄
   */
  clearHistory() {
    this.packetHistory = []
    console.log('[ResourcePack] 歷史記錄已清除')
  }

  /**
   * 獲取狀態
   */
  getStatus() {
    return {
      isEnabled: this.isEnabled,
      autoAccept: this.options.autoAccept,
      historyCount: this.packetHistory.length,
      lastRequest: this.getLastRequest()
    }
  }

  /**
   * 設定自動接受
   */
  setAutoAccept(enabled) {
    this.options.autoAccept = enabled
    console.log(`[ResourcePack] 自動接受已${enabled ? '啟用' : '停用'}`)
  }

  /**
   * 設定日誌記錄
   */
  setLogPackets(enabled) {
    this.options.logPackets = enabled
    console.log(`[ResourcePack] 日誌記錄已${enabled ? '啟用' : '停用'}`)
  }
}

module.exports = ResourcePackHandler