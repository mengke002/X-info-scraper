import { BrowserManager } from './BrowserManager.js';

/**
 * Twitter登录自动化模块
 */
export class TwitterAuth {
  constructor(browserManager, credentials) {
    this.browser = browserManager;
    this.credentials = credentials;
  }

  /**
   * 延迟辅助方法
   */
  sleep(ms) {
    return BrowserManager.sleep(ms);
  }

  /**
   * 自动登录Twitter
   */
  async login() {
    console.log('🔐 开始Twitter登录流程...');

    try {
      // 访问Twitter登录页
      await this.browser.goto('https://twitter.com/i/flow/login');

      // 1. 输入用户名/邮箱
      // 等待用户名输入框出现 (可能是 'text' 或 'email')
      const usernameSelector = 'input[autocomplete="username"]';
      await this.browser.waitForSelector(usernameSelector, { timeout: 20000 });
      console.log('📝 输入用户名/邮箱...');
      await this.browser.type(usernameSelector, this.credentials.username);
      await this.browser.page.keyboard.press('Enter');
      await this.sleep(5000); // 稍微多等一会，让页面响应

      // --- DEBUG: 输入用户名后的状态 ---
      console.log('🔍 [DEBUG] 检查输入用户名后的页面状态...');
      await this.browser.screenshot(`debug-after-username-${Date.now()}.png`);
      await this.browser.dumpPageContent(`debug-after-username-${Date.now()}.html`);
      await this.browser.logPageInfo();
      // -----------------------------

      // 2. 处理可能的中间验证步骤 (例如: 输入手机号或再次确认用户名)
      // 检查是否有密码输入框，如果没有，说明有中间步骤
      try {
        await this.browser.waitForSelector('input[name="password"]', { timeout: 5000 });
      } catch (e) {
        // 没有直接出现密码框，可能需要额外验证
        console.log('⚠️ 未检测到密码框，可能需要额外验证...');
        
        // 再次打印页面状态，确认是否卡住
        await this.browser.logPageInfo();

        // 查找通用的文本输入框 (通常用于验证手机号或用户名)
        let actualInputSelector = '';
        let verificationInput = await this.browser.page.$('input[data-testid="ocfEnterTextTextInput"]');
        if (verificationInput) {
            actualInputSelector = 'input[data-testid="ocfEnterTextTextInput"]';
        } else {
             verificationInput = await this.browser.page.$('input[name="text"]');
             if (verificationInput) {
                 actualInputSelector = 'input[name="text"]';
             }
        }

        if (verificationInput && actualInputSelector) {
            console.log('🔍 检测到中间验证输入框...');
            
            // 策略：
            // 1. 如果有 handle (用户名)，优先使用 handle (这是解决"邮箱登录被要求验证用户名"的关键)
            // 2. 如果提示包含 "phone"，优先尝试 phone
            // 3. 否则使用 username (可能是邮箱)
            
            let valueToType = this.credentials.username; // 默认回填登录账号
            const pageText = await this.browser.page.evaluate(() => document.body.textContent.toLowerCase());
            
            if (this.credentials.handle) {
                 console.log('🛡️ 使用 Handle (用户名) 进行验证...');
                 valueToType = this.credentials.handle;
            } else if (pageText.includes('phone') && this.credentials.phone) {
                 console.log('📱 使用手机号进行验证...');
                 valueToType = this.credentials.phone;
            } else if (pageText.includes('username') && !pageText.includes('email')) {
                 // 明确要求 username 但我们没有 handle，这可能会失败，但也只能试一下 username
                 console.log('⚠️ 页面要求 Username 但未配置 Handle，尝试使用登录账号...');
            }

            console.log(`📝 正在中间验证框中输入: ${valueToType.substring(0, 3)}***`);
            await this.browser.type(actualInputSelector, valueToType); // 使用实际匹配到的选择器
            await this.browser.page.keyboard.press('Enter');
            await this.sleep(3000); // 等待验证通过
        } else {
             console.log('⚠️ 未找到密码框，也未找到验证输入框，页面可能未正确加载');
        }
      }

      // 3. 输入密码
      await this.browser.waitForSelector('input[name="password"]', { timeout: 20000 });
      console.log('🔑 输入密码...');
      await this.browser.type('input[name="password"]', this.credentials.password);
      await this.browser.page.keyboard.press('Enter');
      
      // 等待登录完成
      await this.sleep(8000);

      // 4. 验证登录成功
      const isLoggedIn = await this.verifyLogin();

      if (isLoggedIn) {
        console.log('✅ Twitter登录成功!');
        return true;
      } else {
        // 截图保存失败现场
        await this.browser.screenshot(`login-fail-${Date.now()}.png`);
        throw new Error('登录验证失败 - 请检查日志截图');
      }
    } catch (error) {
      console.error('❌ Twitter登录失败:', error.message);
      const timestamp = Date.now();
      await this.browser.screenshot(`login-error-${timestamp}.png`);
      await this.browser.dumpPageContent(`login-error-${timestamp}.html`);
      await this.browser.logPageInfo();
      throw error;
    }
  }

  /**
   * 处理手机号验证
   */
  async handlePhoneVerification() {
    try {
      // 等待1秒看是否出现手机验证
      await this.sleep(1000);

      const phoneInput = await this.browser.page.$('input[data-testid="ocfEnterTextTextInput"]');

      if (phoneInput && this.credentials.phone) {
        console.log('📱 检测到手机验证,输入手机号...');
        await this.browser.type('input[data-testid="ocfEnterTextTextInput"]', this.credentials.phone);
        await this.browser.page.keyboard.press('Enter');
        await this.browser.randomDelay();
      }
    } catch (error) {
      // 没有手机验证,继续
    }
  }

  /**
   * 验证登录状态
   */
  async verifyLogin() {
    try {
      // 等待页面稳定
      await this.sleep(2000);

      // 检查URL是否跳转到登录页（说明未登录）
      const url = this.browser.page.url();
      console.log(`🔍 当前URL: ${url}`);

      if (url.includes('/login') || url.includes('/i/flow/login')) {
        console.log('❌ 检测到登录页URL，未登录');
        return false;
      }

      // 检查页面内容中是否有"登录"按钮（未登录的标志）
      const hasLoginButton = await this.browser.page.evaluate(() => {
        const text = document.body.textContent || '';
        return text.includes('Log in') || text.includes('Sign in to X') || text.includes('登录');
      });

      if (hasLoginButton && !url.includes('home')) {
        console.log('❌ 检测到登录按钮，未登录');
        return false;
      }

      // 检查是否有侧边栏导航（登录后才有）
      const hasSideNav = await this.browser.page.evaluate(() => {
        // 检查多个可能的登录后才有的元素
        const selectors = [
          '[data-testid="SideNav_AccountSwitcher_Button"]',
          '[data-testid="AppTabBar_Home_Link"]',
          '[aria-label="Home"]',
          '[data-testid="primaryColumn"]',
          'nav[role="navigation"]'
        ];

        for (const selector of selectors) {
          if (document.querySelector(selector)) {
            return true;
          }
        }
        return false;
      });

      if (hasSideNav) {
        console.log('✅ 检测到导航栏，已登录');
        return true;
      }

      // 如果在home页面，即使没找到特定元素也认为已登录
      if (url.includes('home') || url.includes('timeline')) {
        console.log('✅ 在主页，假定已登录');
        return true;
      }

      console.log('⚠️  无法确定登录状态');
      return false;
    } catch (error) {
      console.error('❌ 验证登录状态出错:', error.message);
      return false;
    }
  }

  /**
   * 检查是否已登录(利用userDataDir保存的会话)
   */
  async isAlreadyLoggedIn() {
    try {
      await this.browser.goto('https://twitter.com/home', { waitUntil: 'domcontentloaded' });
      await this.sleep(5000);  // 等待更长时间确保页面完全加载

      return await this.verifyLogin();
    } catch (error) {
      return false;
    }
  }
}

export default TwitterAuth;
