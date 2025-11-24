import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 启用stealth插件,绕过反爬虫检测
puppeteer.use(StealthPlugin());

/**
 * 浏览器管理器 - 处理Puppeteer实例和插件加载
 */
export class BrowserManager {
  constructor(config) {
    this.config = config;
    this.browser = null;
    this.page = null;
    this.extensionMap = {}; // 存储扩展路径到ID的映射
  }

  /**
   * 通用延迟方法（替代已弃用的 waitForTimeout）
   */
  static sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 实例方法版本的 sleep
   */
  async sleep(ms) {
    return BrowserManager.sleep(ms);
  }

  static sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 实例方法版本的 sleep
   */
  async sleep(ms) {
    return BrowserManager.sleep(ms);
  }

  /**
   * 启动浏览器并加载插件（支持单个或多个插件）
   */
  async launch(extensionPath) {
    console.log('🚀 正在启动Chrome浏览器...');

    // 支持传入单个路径或路径数组
    const extensionPaths = Array.isArray(extensionPath) ? extensionPath : [extensionPath];
    // 将相对路径转换为绝对路径，Puppeteer更喜欢绝对路径
    const absoluteExtensionPaths = extensionPaths.map(p => path.resolve(process.cwd(), p));
    const extensionArg = absoluteExtensionPaths.join(',');

    const args = [
      `--disable-extensions-except=${extensionArg}`,
      `--load-extension=${extensionArg}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      `--window-size=${this.config.browser.viewport.width},${this.config.browser.viewport.height}`,
    ];

    // 如果启用stealth模式,添加更多反检测参数
    if (this.config.stealth.enabled) {
      args.push(
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );
    }

    // 添加日志输出，确认正在加载哪些扩展
    console.log(`📦 尝试加载扩展: ${absoluteExtensionPaths.join(', ')}`);

    // 确定 Chrome 可执行文件路径
    let executablePath = null;
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
      console.log(`🔧 使用环境变量指定的 Chrome: ${executablePath}`);
    } else if (process.platform === 'linux') {
      // 在 Linux (GitHub Actions) 环境下，尝试查找常见的 Chrome 路径
      try {
        const { execSync } = await import('child_process');
        const possiblePaths = [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser'
        ];
        for (const p of possiblePaths) {
          try {
            execSync(`which ${p.split('/').pop()}`); // 简单检查命令是否存在
            if (require('fs').existsSync(p)) {
              executablePath = p;
              console.log(`🐧 在 Linux 上找到 Chrome: ${executablePath}`);
              break;
            }
          } catch (e) { /* ignore */ }
        }
      } catch (e) {
        console.warn('⚠️ 查找 Chrome 路径失败:', e.message);
      }
    }

    // 确保 userDataDir 是绝对路径
    const userDataDir = path.resolve(process.cwd(), this.config.browser.userDataDir);
    console.log(`📂 User Data Directory: ${userDataDir}`);

    this.browser = await puppeteer.launch({
      headless: this.config.browser.headless,
      executablePath: executablePath, // 显式指定路径 (如果找到)
      args: [
        ...args,
        // 关键修复：Linux/CI 环境下必须的参数
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', // 防止共享内存不足崩溃
        '--disable-gpu', // Headless 模式通常不需要 GPU
        '--disable-software-rasterizer', // 禁用软件光栅化器
        '--mute-audio', // 静音
        '--autoplay-policy=no-user-gesture-required', // 自动播放策略
        '--disable-audio-output', // 🔇 禁用音频输出 (彻底屏蔽 ALSA 错误)
        '--no-first-run', // 跳过首次运行检查
        '--no-default-browser-check', // 跳过默认浏览器检查
        '--disable-infobars', // 禁用信息栏
        '--disable-notifications', // 禁用通知
        '--log-level=3', // 关键：只显示 FATAL 级别的日志，屏蔽 D-Bus, UPower, ALSA 错误
        `--user-data-dir=${userDataDir}` // 显式在 args 中也指定一次，双重保险
      ],
      defaultViewport: this.config.browser.viewport,
      slowMo: this.config.browser.slowMo,
      userDataDir: userDataDir, // Puppeteer 选项
      ignoreDefaultArgs: ['--enable-automation', '--enable-blink-features=AutomationControlled'],
      dumpio: false, // 🔇 关闭 dumpio，避免 ALSA 错误输出到日志
    });

    console.log('✅ 浏览器启动成功');

    // 获取主页面
    const pages = await this.browser.pages();
    this.page = pages[0] || await this.browser.newPage();

    // 注入反检测脚本
    await this.setupStealthMode();

    // 建立扩展路径到ID的映射 (在浏览器启动后，通过访问 chrome://extensions 页面获取更可靠)
    await this.mapExtensionsReliably(absoluteExtensionPaths);

    return { browser: this.browser, page: this.page };
  }

  /**
   * 建立扩展路径到ID的可靠映射
   * 通过访问 chrome://extensions 页面获取更准确的扩展ID
   */
  async mapExtensionsReliably(absoluteExtensionPaths) {
    console.log('🔍 尝试识别已加载的扩展...');

    // 方法1: 通过 chrome://extensions 页面识别（仅在非 headless 模式或能正确渲染的环境下有效）
    try {
      const extensionsPage = await this.browser.newPage();
      try {
        await extensionsPage.goto('chrome://extensions', { waitUntil: 'load', timeout: 10000 });
        await BrowserManager.sleep(2000); // 等待页面内容加载

        const result = await extensionsPage.evaluate((paths) => {
          const map = {};
          const debugInfo = []; // 用于调试

          try {
            // 获取扩展管理器中的所有项目
            // 注意：chrome://extensions 页面是一个 Shadow DOM 结构，需要穿透 Shadow Root
            const manager = document.querySelector('extensions-manager');
            if (!manager || !manager.shadowRoot) {
              return { map, debugInfo, error: 'extensions-manager not found or no shadowRoot' };
            }

            const itemList = manager.shadowRoot.querySelector('#items-list');
            if (!itemList || !itemList.shadowRoot) {
              return { map, debugInfo, error: 'items-list not found or no shadowRoot' };
            }

            const extensionItems = itemList.shadowRoot.querySelectorAll('extensions-item');
            if (extensionItems.length === 0) {
              return { map, debugInfo, error: 'no extension items found' };
            }

            extensionItems.forEach(item => {
              const nameElement = item.shadowRoot.querySelector('#name');
              const name = nameElement ? nameElement.textContent.trim() : '';
              const id = item.getAttribute('id'); // 扩展ID

              debugInfo.push({ name, id }); // 记录所有扩展信息

              // 尝试通过名称或路径匹配
              // 优先匹配名称，名称匹配更精确
              // TwExport 扩展名称: "TwExport - Export Tweets From Any Account"
              if (name.includes('TwExport')) {
                map['TwExport'] = id;
              }
              // Twitter Export Follower 扩展名称: "Twitter Export Follower" 或 "Export Twitter Follower"
              else if (name.includes('Twitter') && name.includes('Follower')) {
                map['Twitter Export Follower'] = id;
              }
            });
          } catch (e) {
            return { map, debugInfo, error: e.message };
          }
          return { map, debugInfo };
        }, absoluteExtensionPaths);

        // 打印调试信息
        if (result.error) {
          console.warn(`⚠️  通过 chrome://extensions 识别失败: ${result.error}`);
        } else if (result.debugInfo && result.debugInfo.length > 0) {
          console.log('🔍 检测到的所有扩展:', JSON.stringify(result.debugInfo, null, 2));
        }

        if (result.map && Object.keys(result.map).length > 0) {
          this.extensionMap = result.map;
        }

        await extensionsPage.close();
      } catch (error) {
        console.warn('⚠️  通过 chrome://extensions 识别失败:', error.message);
        await extensionsPage.close();
      }
    } catch (error) {
      console.warn('⚠️  无法打开 chrome://extensions 页面:', error.message);
    }

    // 方法2: 通过 browser.targets() 获取扩展 ID（更可靠的降级方案）
    if (Object.keys(this.extensionMap).length === 0) {
      console.log('🔄 降级方案: 通过 targets 识别扩展...');
      try {
        const targets = await this.browser.targets();
        const foundExtensions = new Set();

        for (const target of targets) {
          const url = target.url();
          if (url.includes('chrome-extension://')) {
            const match = url.match(/chrome-extension:\/\/([a-z]{32})/);
            if (match) {
              const extensionId = match[1];

              // 根据文件夹路径推断扩展类型
              for (const extPath of absoluteExtensionPaths) {
                if (extPath.includes('TwExport') && !foundExtensions.has('TwExport')) {
                  this.extensionMap['TwExport'] = extensionId;
                  foundExtensions.add('TwExport');
                  console.log(`🔗 通过 targets 识别 TwExport (ID: ${extensionId})`);
                } else if (extPath.includes('Twitter Export Follower') && !foundExtensions.has('Twitter Export Follower')) {
                  this.extensionMap['Twitter Export Follower'] = extensionId;
                  foundExtensions.add('Twitter Export Follower');
                  console.log(`🔗 通过 targets 识别 Twitter Export Follower (ID: ${extensionId})`);
                }
              }
            }
          }
        }
      } catch (error) {
        console.error('❌ 通过 targets 识别扩展时出错:', error.message);
      }
    }

    // 方法3: 通过读取 manifest.json 获取扩展 ID（最终降级方案）
    if (Object.keys(this.extensionMap).length === 0) {
      console.log('🔄 最终降级方案: 通过 manifest.json 中的 key 计算扩展 ID...');
      try {
        const fs = await import('fs');
        const crypto = await import('crypto');
        const pathModule = await import('path');

        for (const extPath of absoluteExtensionPaths) {
          // 检查扩展目录是否存在
          if (!fs.existsSync(extPath)) {
            console.error(`❌ 扩展目录不存在: ${extPath}`);
            continue;
          }

          const manifestPath = pathModule.join(extPath, 'manifest.json');
          if (fs.existsSync(manifestPath)) {
            const manifestContent = fs.readFileSync(manifestPath, 'utf8');
            const manifest = JSON.parse(manifestContent);

            // 如果 manifest.json 中有 key 字段，可以计算出扩展 ID
            if (manifest.key) {
              // Chrome 扩展 ID 计算: SHA256(publicKey).slice(0, 32).map(byte => 'a' + byte % 26)
              const publicKeyDer = Buffer.from(manifest.key, 'base64');
              const hash = crypto.createHash('sha256').update(publicKeyDer).digest();

              // 转换为扩展 ID（前16字节，每个字节映射为 a-p）
              const extensionId = Array.from(hash.slice(0, 16))
                .map(byte => String.fromCharCode(97 + (byte % 16)))
                .join('');

              if (extPath.includes('TwExport')) {
                this.extensionMap['TwExport'] = extensionId;
                console.log(`🔗 通过 manifest.json 计算 TwExport ID: ${extensionId}`);
              } else if (extPath.includes('Twitter Export Follower')) {
                this.extensionMap['Twitter Export Follower'] = extensionId;
                console.log(`🔗 通过 manifest.json 计算 Twitter Export Follower ID: ${extensionId}`);
              }
            } else {
              console.warn(`⚠️  ${extPath} 的 manifest.json 中没有 key 字段`);
            }
          } else {
            console.error(`❌ manifest.json 不存在: ${manifestPath}`);
          }
        }
      } catch (error) {
        console.error('❌ 通过 manifest.json 计算扩展 ID 失败:', error.message);
      }
    }

    // 最终验证
    if (this.extensionMap['TwExport']) {
      console.log(`✅ TwExport 扩展已识别 (ID: ${this.extensionMap['TwExport']})`);
    } else {
      console.warn('⚠️  未能识别 TwExport 扩展');
    }
    if (this.extensionMap['Twitter Export Follower']) {
      console.log(`✅ Twitter Export Follower 扩展已识别 (ID: ${this.extensionMap['Twitter Export Follower']})`);
    } else {
      console.warn('⚠️  未能识别 Twitter Export Follower 扩展');
    }
  }

  /**
   * 设置反检测模式
   */
  async setupStealthMode() {
    if (!this.config.stealth.enabled) return;

    console.log('🕵️  设置反检测模式...');

    // 注入脚本移除webdriver标识
    await this.page.evaluateOnNewDocument(() => {
      // 移除webdriver标识
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });

      // 伪装Chrome对象
      window.chrome = {
        runtime: {},
      };

      // 伪装权限
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: Notification.permission }) :
          originalQuery(parameters)
      );

      // 伪装插件
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
      });

      // 伪装语言
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });
    });

    console.log('✅ 反检测模式设置完成');
  }

  /**
   * 导航到指定URL
   */
  async goto(url, options = {}) {
    const defaultOptions = {
      waitUntil: 'networkidle2',
      timeout: 60000,
    };

    await this.page.goto(url, { ...defaultOptions, ...options });

    // 随机延迟,模拟人类行为
    if (this.config.stealth.humanBehavior) {
      await this.randomDelay();
    }
  }

  /**
   * 随机延迟
   */
  async randomDelay() {
    const [min, max] = this.config.stealth.randomDelay;
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    await this.sleep(delay);
  }

  /**
   * 模拟人类鼠标移动
   */
  async humanMouseMove(x, y) {
    if (!this.config.stealth.humanBehavior) {
      await this.page.mouse.move(x, y);
      return;
    }

    // 获取当前鼠标位置(假设从中心开始)
    const startX = this.config.browser.viewport.width / 2;
    const startY = this.config.browser.viewport.height / 2;

    // 计算贝塞尔曲线路径
    const steps = 20;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const currentX = startX + (x - startX) * t;
      const currentY = startY + (y - startY) * t;

      await this.page.mouse.move(currentX, currentY);
      await this.sleep(10);
    }
  }

  /**
   * 安全关闭浏览器
   */
  async close() {
    if (this.browser) {
      console.log('🔒 正在关闭浏览器...');
      await this.browser.close();
      this.browser = null;
      this.page = null;
      console.log('✅ 浏览器已关闭');
    }
  }

  /**
   * 截图(用于调试)
   */
  async screenshot(filename) {
    const screenshotPath = path.join(__dirname, '../../logs', filename);
    await this.page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`📸 截图已保存: ${screenshotPath}`);
  }

  /**
   * 等待选择器出现
   */
  async waitForSelector(selector, options = {}) {
    return await this.page.waitForSelector(selector, {
      timeout: 30000,
      ...options
    });
  }

  /**
   * 点击元素(带人类行为模拟)
   */
  async click(selector) {
    await this.waitForSelector(selector);

    if (this.config.stealth.humanBehavior) {
      // 获取元素位置
      const element = await this.page.$(selector);
      const box = await element.boundingBox();

      if (box) {
        // 移动到元素中心
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        await this.humanMouseMove(x, y);
        await this.randomDelay();
      }
    }

    await this.page.click(selector);
    await this.randomDelay();
  }

  /**
   * 输入文本(带人类行为模拟)
   */
  async type(selector, text, options = {}) {
    await this.waitForSelector(selector);
    await this.click(selector);

    if (this.config.stealth.humanBehavior) {
      // 逐字输入,随机延迟
      for (const char of text) {
        await this.page.keyboard.type(char);
        await this.sleep(Math.random() * 100 + 50);
      }
    } else {
      await this.page.type(selector, text, options);
    }

    await this.randomDelay();
  }
}

export default BrowserManager;
