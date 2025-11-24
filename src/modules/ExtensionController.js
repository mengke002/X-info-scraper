import { BrowserManager } from './BrowserManager.js';

/**
 * 插件交互控制器 - 处理Chrome插件的UI操作
 * 支持完全自动化的批量采集
 */
export class ExtensionController {
  constructor(browserManager, config) {
    this.browser = browserManager;
    this.config = config;
    this.extensionPage = null;
    this.extensionId = null;  // 缓存插件ID
    this.currentExtensionType = null;  // 当前加载的插件类型
  }

  /**
   * 延迟辅助方法
   */
  sleep(ms) {
    return BrowserManager.sleep(ms);
  }

  /**
   * 在插件中填入Twitter用户名
   */
  async fillUsername(username) {
    try {
      // 查找用户名输入框
      const inputSelectors = [
        'input[placeholder*="sername"]',
        'input[placeholder*="Username"]',
        'input[type="text"]',
        'input[name="username"]',
        '#username'
      ];

      for (const selector of inputSelectors) {
        const input = await this.extensionPage.$(selector);
        if (input) {
          // 清空输入框
          await input.click({ clickCount: 3 }); // 选中全部
          await this.extensionPage.keyboard.press('Backspace');

          try {
            // 尝试使用粘贴方式 (更准确且快)
            await this.extensionPage.evaluate((text) => {
                const input = document.activeElement;
                if(input && (input.tagName === 'INPUT' || input.tagName === 'TEXTAREA')) {
                    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
                    nativeInputValueSetter.call(input, text);
                    const ev2 = new Event('input', { bubbles: true});
                    input.dispatchEvent(ev2);
                }
            }, username);
          } catch (pasteError) {
               await input.type(username, { delay: 50 });
          }

          await this.sleep(500);
          return true;
        }
      }
      return false;
    } catch (error) {
      return false;
    }
  }
  /**
   * 根据数据类型确定使用的插件
   */
  getExtensionForType(dataType) {
    const typeMap = {
      'posts': 'tweetExport',
      'tweets': 'tweetExport',
      'replies': 'tweetExport',
      'followers': 'followerExport',
      'following': 'followerExport'
    };
    return typeMap[dataType] || 'tweetExport';
  }

  /**
   * 打开插件页面
   */
  async openExtension(dataType = null) {
    // 获取所有页面
    let pages = await this.browser.browser.pages();

    // 查找插件页面(通常是chrome-extension://开头的URL)
    for (const page of pages) {
      const url = page.url();
      if (url.includes('chrome-extension://') && (url.includes('popup.html') || url.includes('exportDashboard'))) {
        this.extensionPage = page;
        break;
      }
    }

    // 如果没找到，尝试获取插件ID并直接打开popup
    if (!this.extensionPage) {
      try {
        const extensionId = await this.getExtensionId(dataType);

        if (extensionId) {
          const popupUrl = `chrome-extension://${extensionId}/popup.html`;
          const popupPage = await this.browser.browser.newPage();
          await popupPage.goto(popupUrl, { waitUntil: 'domcontentloaded' });
          await this.sleep(2000);

          this.extensionPage = popupPage;
          await this.extensionPage.bringToFront();
          return true;
        }
      } catch (error) {
        // 降级：等待用户手动点击
      }

      // 如果还是没找到，等待用户手动点击
      console.log('⚠️  请手动点击插件图标...');
      await this.sleep(10000);

      pages = await this.browser.browser.pages();
      for (const page of pages) {
        const url = page.url();
        if (url.includes('chrome-extension://')) {
          this.extensionPage = page;
          break;
        }
      }
    }

    if (this.extensionPage) {
      await this.extensionPage.bringToFront();
      return true;
    }

    throw new Error('无法打开插件页面');
  }

  /**
   * 获取扩展ID - 支持根据类型选择正确的扩展
   */
  async getExtensionId(preferredType = null) {
    try {
      // 如果有类型偏好，使用BrowserManager中的extensionMap
      if (preferredType && this.browser.extensionMap) {
        let extensionType = preferredType;
        if (['posts', 'tweets', 'replies', 'followers', 'following'].includes(preferredType)) {
          extensionType = this.getExtensionForType(preferredType);
        }

        const extFolderMap = {
          'tweetExport': 'TwExport',
          'followerExport': 'Twitter Export Follower'
        };

        const folderName = extFolderMap[extensionType];
        if (folderName && this.browser.extensionMap[folderName]) {
          return this.browser.extensionMap[folderName];
        }
      }

      // 降级方案: 从 browser targets 查找
      const targets = await this.browser.browser.targets();
      const extensionIds = [];

      for (const target of targets) {
        const url = target.url();
        if (url.includes('chrome-extension://')) {
          const match = url.match(/chrome-extension:\/\/([a-z]{32})/);
          if (match) {
            extensionIds.push({ id: match[1], url: url });
          }
        }
      }

      if (extensionIds.length > 0) {
        return extensionIds[0].id;
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * 导航到Twitter用户页面
   */
  async navigateToUser(username) {
    const userUrl = `https://twitter.com/${username}`;
    await this.browser.goto(userUrl);
    await this.sleep(3000);

    const exists = await this.browser.page.evaluate(() => {
      return !document.body.textContent.includes("This account doesn't exist");
    });

    if (!exists) {
      throw new Error(`用户 @${username} 不存在`);
    }
  }

  /**
   * 在插件中选择采集类型
   */
  async selectExportType(type) {
    if (!this.extensionPage) {
      await this.openExtension();
    }

    await this.extensionPage.bringToFront();

    try {
      const selected = await this.extensionPage.evaluate((targetType) => {
        const labels = document.querySelectorAll('label');

        for (const label of labels) {
          const text = label.textContent.trim();

          if (
            (targetType === 'posts' && (text === 'Posts' || text === 'Tweets')) ||
            (targetType === 'replies' && text === 'Replies') ||
            (targetType === 'following' && text === 'Following') ||
            (targetType === 'followers' && (text === 'Followers' || text === 'Verified Followers'))
          ) {
            const radio = label.querySelector('input[type="radio"]') ||
                         document.querySelector(`input[type="radio"][id="${label.getAttribute('for')}"]`);

            if (radio) {
              radio.click();
              return true;
            }
            label.click();
            return true;
          }
        }
        return false;
      }, type);

      if (selected) {
        await this.sleep(500);
        return true;
      }
      return false;

    } catch (error) {
      return false;
    }
  }

  /**
   * 尝试打开dropdown菜单
   */
  async tryOpenDropdown(triggerSelector) {
    try {
      const triggers = triggerSelector.split(', ');
      for (const trigger of triggers) {
        const element = await this.extensionPage.$(trigger);
        if (element) {
          await element.click();
          await this.sleep(300);
          return true;
        }
      }
    } catch (error) { /* ignore */ }
    return false;
  }

  /**
   * 尝试多种选择器选择选项
   */
  async trySelectOption(selectors, type) {
    for (const selector of selectors) {
      try {
        // 使用evaluate来处理:has-text这种非标准选择器
        if (selector.includes(':has-text')) {
          const text = selector.match(/:has-text\("(.+?)"\)/)?.[1];
          if (text) {
            const clicked = await this.extensionPage.evaluate((searchText) => {
              const elements = document.querySelectorAll('button, label, li, div[role="option"], span');
              for (const el of elements) {
                if (el.textContent.trim() === searchText || el.textContent.includes(searchText)) {
                  el.click();
                  return true;
                }
              }
              return false;
            }, text);

            if (clicked) return true;
          }
        } else {
          const element = await this.extensionPage.$(selector);
          if (element) {
            await element.click();
            return true;
          }
        }
      } catch (error) {
        continue;
      }
    }
    return false;
  }

  /**
   * 通过文本内容查找并选择选项
   */
  async selectByTextContent(type) {
    const typeTextMap = {
      'posts': ['Posts', 'posts', '推文', 'Tweets'],
      'tweets': ['Tweets', 'tweets', '推文', 'Posts'],
      'replies': ['Replies', 'replies', '回复', 'Replies & Quotes'],
      'followers': ['Followers', 'followers', '粉丝', '关注者'],
      'following': ['Following', 'following', '正在关注', '关注']
    };

    const searchTexts = typeTextMap[type] || [type];

    return await this.extensionPage.evaluate((texts) => {
      // 查找所有可点击元素
      const clickableElements = document.querySelectorAll(
        'button, [role="button"], [role="option"], [role="menuitem"], ' +
        'label, li, .p-dropdown-item, [class*="option"], [class*="item"]'
      );

      for (const text of texts) {
        for (const el of clickableElements) {
          const elText = el.textContent.trim();
          if (elText === text || elText.toLowerCase() === text.toLowerCase()) {
            el.click();
            return true;
          }
        }
      }
      return false;
    }, searchTexts);
  }

  /**
   * 设置采集数量限制
   */
  async setMaxCount(maxCount) {
    if (!maxCount) return;

    console.log(`🔢 设置采集数量限制: ${maxCount}`);

    try {
      // 查找数量输入框
      const inputSelectors = [
        'input[type="number"]',
        'input[placeholder*="count"]',
        'input[placeholder*="数量"]',
        'input[name="count"]',
        'input[name="limit"]',
        '.p-inputnumber input'  // PrimeReact InputNumber
      ];

      for (const selector of inputSelectors) {
        const input = await this.extensionPage.$(selector);
        if (input) {
          await input.click({ clickCount: 3 });  // 选中全部
          await input.type(String(maxCount));
          console.log(`✅ 已设置数量限制: ${maxCount}`);
          return true;
        }
      }
    } catch (error) {
      console.warn(`⚠️  无法设置数量限制: ${error.message}`);
    }
    return false;
  }

  /**
   * 完整的自动配置流程
   */
  async autoConfigureExtension(type, maxCount = null, username = null) {
    console.log(`🤖 开始自动配置插件: ${type}`);

    // 1. 打开插件（传入类型以选择正确的扩展）
    //    如果插件页已经打开且是同类型，复用它；否则重新打开
    const needReopen = !this.extensionPage || this.extensionPage.isClosed() || this.currentExtensionType !== this.getExtensionForType(type);

    if (needReopen) {
      console.log(`🔄 ${this.extensionPage ? '切换' : '打开'}扩展...`);
      await this.openExtension(type);
      this.currentExtensionType = this.getExtensionForType(type);
    } else {
      console.log('♻️  复用已打开的插件页');
      await this.extensionPage.bringToFront();
    }

    // 2. 填入用户名（如果提供）
    if (username) {
      await this.fillUsername(username);
    }

    // 3. 选择类型
    const typeSelected = await this.selectExportType(type);

    // 4. 设置数量限制
    if (maxCount) {
      await this.setMaxCount(maxCount);
    }

    // 5. 等待UI稳定
    await this.sleep(500);

    return typeSelected;
  }

  /**
   * 关闭升级 Pro 弹窗
   */
  async closeUpgradeDialog(page) {
    try {
      const closed = await page.evaluate(() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          const text = btn.textContent.trim().toLowerCase();
          if (text.includes('no thanks') || text.includes('not now') ||
              text.includes('maybe later') || text.includes('close') ||
              text.includes('×') || text === 'x') {
            btn.click();
            return true;
          }
        }
        return false;
      });

      if (closed) {
        console.log('✅ 已关闭升级弹窗');
        await this.sleep(500);
      }
      return closed;
    } catch (error) {
      // 忽略错误
      return false;
    }
  }

  /**
   * 开始导出
   */
  async startExport() {
    if (!this.extensionPage) {
      await this.openExtension();
    }

    await this.extensionPage.bringToFront();

    // 查找并点击"Start Exporting"按钮
    const clicked = await this.extensionPage.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const button of buttons) {
        const text = button.textContent.trim();
        if (text.includes('Start') || text.includes('Export') || text.includes('开始')) {
          button.click();
          return true;
        }
      }
      return false;
    });

    if (clicked) {
        // 等待 Dashboard 页面打开
        try {
            const dashboardTarget = await this.browser.browser.waitForTarget(
                (target) => target.url().includes('exportDashboard.html'),
                { timeout: 15000 }
            );

            const dashboardPage = await dashboardTarget.page();
            if (dashboardPage) {
                await this.sleep(1000);
                // 尝试关闭升级弹窗
                await this.closeUpgradeDialog(dashboardPage);
                return dashboardPage;
            }
        } catch (e) {
            // 降级：直接查找现有的 Dashboard 页面
            const pages = await this.browser.browser.pages();
            for (const page of pages) {
                const url = page.url();
                if (url.includes('chrome-extension://') && url.includes('exportDashboard')) {
                    await this.sleep(1000);
                    // 尝试关闭升级弹窗
                    await this.closeUpgradeDialog(page);
                    return page;
                }
            }
        }

        console.error('❌ 无法找到Dashboard页面');
        return null;
    }

    console.warn('⚠️  无法自动点击导出按钮');
    return null;
  }

    /**
   * 监控导出进度
   */
  async monitorProgress(dashboardPage, targetCount = null) {
    console.log(`📊 监控导出进度${targetCount ? ` (目标: ${targetCount}条)` : ''}...`);

    // 先尝试关闭升级弹窗
    await this.closeUpgradeDialog(dashboardPage).catch(() => {});

    const startTime = Date.now();
    const maxWaitTime = 60000; // 最长等待60秒，无论如何都要尝试导出
    let lastCount = 0;
    let noProgressCount = 0;
    let stableCount = 0;
    const maxNoProgress = 20; // 20秒无进展就停止
    const maxStableCount = 15; // 15秒稳定就停止

    while (true) {
      try {
        // 检查是否超过最长等待时间
        const elapsed = Date.now() - startTime;
        if (elapsed > maxWaitTime) {
          console.log(`⏱️  已等待 ${(elapsed / 1000).toFixed(1)}s，超过最长等待时间`);
          console.log(`   当前采集到 ${lastCount} 条数据，强制尝试导出...`);
          break;
        }

        if (!dashboardPage || dashboardPage.isClosed()) break;

        await dashboardPage.bringToFront().catch(() => {});

        // 读取当前采集的数据量（加超时保护）
        const progress = await Promise.race([
          dashboardPage.evaluate(() => {
            const text = document.body.textContent;
            const table = document.querySelector('table');
            let rowCount = 0;
            if (table) {
              const rows = table.querySelectorAll('tbody tr, tr[role="row"]');
              rowCount = rows.length;
            }

            const exportButtons = Array.from(document.querySelectorAll('button'));
            for (const btn of exportButtons) {
              const match = btn.textContent.match(/Export\s+(?:Posts?|Replies?|Following|Followers?)\s*\((\d+)\)/i);
              if (match) {
                return {
                  count: parseInt(match[1]),
                  hasExportButton: true,
                  buttonText: btn.textContent.trim()
                };
              }
            }

            const has300Limit = text.includes('You can export up to 300') ||
                               text.includes('export up to 300 tweets only') ||
                               text.includes('export up to 300 data entries');

            const isExtracting = text.includes('Extracting') ||
                                text.includes('Please wait');

            return {
              count: rowCount || 0,
              hasExportButton: false,
              has300Limit,
              isExtracting
            };
          }).catch(() => ({ count: 0, hasExportButton: false, has300Limit: false, isExtracting: false })),
          new Promise((_, reject) => setTimeout(() => reject(new Error('evaluate timeout')), 5000))
        ]).catch(() => ({
          count: lastCount, // 超时时使用上次的值
          hasExportButton: false,
          has300Limit: false,
          isExtracting: false
        }));

        const currentCount = progress.count;

        // 显示进度
        if (currentCount > 0 && currentCount !== lastCount) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(`📈 已采集: ${currentCount} 条 (用时: ${elapsed}秒)`);
          lastCount = currentCount;
          noProgressCount = 0;
          stableCount = 0;
        } else if (currentCount > 0 && currentCount === lastCount) {
          if (progress.isExtracting) {
            stableCount = 0;
          } else {
            stableCount++;
          }
        }

        // 判断是否完成
        let shouldStop = false;
        let stopReason = '';

        // 优先级1: 达到目标数量
        if (targetCount && currentCount >= targetCount) {
          shouldStop = true;
          stopReason = `已达到目标数量 ${targetCount}`;
        }
        // 优先级2: 达到插件300条限制
        else if (progress.has300Limit && currentCount >= 300) {
          shouldStop = true;
          stopReason = '已达到300条限制（免费版限制）';
        }
        // 优先级3: 长时间无进展
        else if (!progress.isExtracting && noProgressCount > maxNoProgress) {
          shouldStop = true;
          stopReason = `${noProgressCount}秒无进展，当前 ${currentCount} 条`;
        }
        // 优先级4: 数量稳定
        else if (!targetCount && stableCount >= maxStableCount && currentCount > 0) {
          shouldStop = true;
          stopReason = '数量稳定';
        }

        if (shouldStop) {
          console.log(`✅ 监控完成! 共 ${currentCount} 条数据`);
          if (stopReason) {
            console.log(`   停止原因: ${stopReason}`);
          }
          break;
        }

        if (progress.isExtracting) {
          noProgressCount = 0;
        } else {
          noProgressCount++;
        }

        await this.sleep(1000);

      } catch (error) {
        console.warn(`⚠️  监控出错: ${error.message}，尝试继续...`);
        // 不要直接 break，继续尝试
        await this.sleep(1000);
      }
    }
  }

  /**
   * 点击 Export 按钮触发下载（增强错误处理）
   */
  async clickExportButton(page = null) {
    console.log('💾 点击导出按钮...');
    const targetPage = page || this.extensionPage;

    try {
      if (!targetPage || targetPage.isClosed()) {
        console.warn('⚠️  页面已关闭，无法点击导出按钮');
        return false;
      }

      await targetPage.bringToFront().catch(() => {});

      // 先尝试关闭升级弹窗
      await this.closeUpgradeDialog(targetPage).catch(() => {});

      // 设置下载行为
      const client = await targetPage.target().createCDPSession();
      const downloadPath = process.env.HOME + '/Downloads';
      await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadPath
      }).catch(() => {});

      // 点击导出按钮（加超时保护）
      const clicked = await Promise.race([
        targetPage.evaluate(() => {
          const buttons = document.querySelectorAll('button');
          for (const btn of buttons) {
            if (btn.textContent.match(/Export\s+(?:Posts?|Replies?|Following|Followers?)\s*\(\d+\)/i)) {
              btn.click();
              return true;
            }
          }
          return false;
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('click timeout')), 5000))
      ]).catch(() => false);

      if (clicked) {
        console.log('✅ 已点击导出按钮，等待下载...');
        await this.sleep(2000);
        return true;
      }

      console.warn('⚠️  未找到导出按钮，可能已经下载');
      return false;
    } catch (error) {
      console.warn(`⚠️  点击导出按钮出错: ${error.message}`);
      return false;
    }
  }

  async downloadData() {
    console.log('💾 准备下载数据...');

    if (!this.extensionPage) return null;

    await this.extensionPage.bringToFront();

    // 查找下载按钮
    const downloadSelectors = [
      'button:has-text("Download")',
      'button:has-text("下载")',
      'a[download]',
      '[data-action="download"]'
    ];

    for (const selector of downloadSelectors) {
      try {
        const element = await this.extensionPage.$(selector);
        if (element) {
          // 设置下载路径
          const downloadPath = this.config.output.directory;

          // 监听下载事件
          const client = await this.extensionPage.target().createCDPSession();
          await client.send('Page.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath
          });

          // 点击下载
          await this.extensionPage.click(selector);
          console.log('✅ 已触发下载');

          await this.sleep(3000);
          return true;
        }
      } catch (error) {
        continue;
      }
    }

    console.log('💡 提示: 请手动点击下载按钮');
    return false;
  }

  /**
   * 获取插件中的数据(不通过下载)
   */
  async extractDataFromPlugin() {
    console.log('📤 直接从插件提取数据...');

    if (!this.extensionPage) return [];

    await this.extensionPage.bringToFront();
    await this.sleep(1000); // 等待表格稳定

    // 从页面DOM中提取数据
    const data = await this.extensionPage.evaluate(() => {
      const rows = [];

      // 查找数据表格
      const table = document.querySelector('table, [role="table"]');

      if (table) {
        // 查找tbody中的行，或者直接查找所有tr
        const tbody = table.querySelector('tbody');
        const tableRows = tbody ?
          tbody.querySelectorAll('tr, [role="row"]') :
          table.querySelectorAll('tr, [role="row"]');

        console.log(`Found ${tableRows.length} rows in table`);

        tableRows.forEach((row, index) => {
          // 检查是否是表头行（包含th元素）
          const hasHeader = row.querySelector('th');
          if (hasHeader) {
            console.log(`Skipping header row ${index}`);
            return;
          }

          const cells = row.querySelectorAll('td, [role="cell"]');
          if (cells.length > 0) {
            const rowData = {};
            cells.forEach((cell, i) => {
              rowData[`column_${i}`] = cell.textContent.trim();
            });
            rows.push(rowData);
          }
        });
      } else {
        console.log('No table found on page');
      }

      return rows;
    });

    console.log(`✅ 提取到 ${data.length} 条数据`);
    return data;
  }
}

export default ExtensionController;
