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

      // 等待用户名输入框
      await this.browser.waitForSelector('input[autocomplete="username"]', { timeout: 15000 });
      console.log('📝 输入用户名/邮箱...');
      await this.browser.type('input[autocomplete="username"]', this.credentials.username);

      // 点击"下一步"
      await this.browser.page.keyboard.press('Enter');
      await this.browser.randomDelay();

      // 处理可能的手机验证
      await this.handlePhoneVerification();

      // 输入密码
      await this.browser.waitForSelector('input[name="password"]', { timeout: 15000 });
      console.log('🔑 输入密码...');
      await this.browser.type('input[name="password"]', this.credentials.password);

      // 提交登录
      await this.browser.page.keyboard.press('Enter');
      await this.sleep(5000);

      // 验证登录成功
      const isLoggedIn = await this.verifyLogin();

      if (isLoggedIn) {
        console.log('✅ Twitter登录成功!');
        return true;
      } else {
        throw new Error('登录验证失败');
      }
    } catch (error) {
      console.error('❌ Twitter登录失败:', error.message);
      await this.browser.screenshot(`login-error-${Date.now()}.png`);
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
