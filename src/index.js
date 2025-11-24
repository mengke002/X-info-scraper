#!/usr/bin/env node

import config from '../config.js';
import { BrowserManager } from './modules/BrowserManager.js';
import { TwitterAuth } from './modules/TwitterAuth.js';
import { ExtensionController } from './modules/ExtensionController.js';
import { DataExporter } from './modules/DataExporter.js';
import readline from 'readline';
import path from 'path';

/**
 * Twitter数据采集器 - 主程序
 */
class TwitterScraper {
  constructor(userConfig = {}) {
    // 合并用户配置
    this.config = { ...config, ...userConfig };

    this.browser = null;
    this.auth = null;
    this.extensionCtrl = null;
    this.exporter = null;
  }

  /**
   * 初始化
   */
  async init() {
    console.log('╔════════════════════════════════════════╗');
    console.log('║   Twitter 数据采集器 v1.0            ║');
    console.log('║   使用原版插件 | 半自动化              ║');
    console.log('╚════════════════════════════════════════╝\n');

    // 验证配置
    this.validateConfig();

    // 使用原版插件 (不打补丁)
    console.log('📦 加载原版插件...');
    const extensionPath = path.resolve(process.cwd(), this.config.extensions.followerExport);

    // 初始化浏览器管理器
    this.browser = new BrowserManager(this.config);

    // 启动浏览器并加载插件
    await this.browser.launch(extensionPath);

    // 初始化认证模块
    this.auth = new TwitterAuth(this.browser, this.config.twitter);

    // 初始化插件控制器
    this.extensionCtrl = new ExtensionController(this.browser, this.config);

    // 初始化数据导出器
    this.exporter = new DataExporter(this.config);

    console.log('✅ 初始化完成!\n');
  }

  /**
   * 验证配置
   */
  validateConfig() {
    if (!this.config.twitter.username || !this.config.twitter.password) {
      throw new Error('❌ 错误: 请在config.js中配置Twitter账号信息');
    }

    if (!this.config.target.username) {
      throw new Error('❌ 错误: 请在config.js中配置目标用户名');
    }

    console.log('📋 配置验证通过');
    console.log(`   目标用户: @${this.config.target.username}`);
    console.log(`   采集类型: ${this.config.target.type}`);
    console.log(`   最大数量: ${this.config.target.maxCount || '无限制'}\n`);
  }

  /**
   * 执行采集任务
   */
  async run() {
    try {
      await this.init();

      // 1. Twitter登录
      console.log('\n📍 步骤 1/5: Twitter登录');
      const isLoggedIn = await this.auth.isAlreadyLoggedIn();

      if (!isLoggedIn) {
        await this.auth.login();
      } else {
        console.log('✅ 检测到已登录,跳过登录步骤');
      }

      // 2. 导航到目标用户
      console.log('\n📍 步骤 2/5: 导航到目标用户');
      await this.extensionCtrl.navigateToUser(this.config.target.username);

      // 3. 打开并配置插件
      console.log('\n📍 步骤 3/5: 配置插件');
      await this.extensionCtrl.openExtension();

      // 等待用户手动配置(或自动选择)
      console.log('\n⚠️  请在插件界面进行以下操作:');
      console.log(`   1. 确认选择了正确的采集类型: ${this.config.target.type}`);
      console.log('   2. 调整其他设置(如需要)');
      console.log('   3. 点击"导出"或"Start"按钮\n');

      await this.promptUser('配置完成后按回车继续...');

      // 或者尝试自动选择
      // await this.extensionCtrl.selectExportType(this.config.target.type);
      // await this.extensionCtrl.startExport();

      // 4. 监控采集进度
      console.log('\n📍 步骤 4/5: 监控采集进度');
      await this.extensionCtrl.monitorProgress();

      // 5. 导出数据
      console.log('\n📍 步骤 5/5: 导出数据');

      // 尝试直接从插件提取数据
      const data = await this.extensionCtrl.extractDataFromPlugin();

      if (data && data.length > 0) {
        this.exporter.addData(data);
      } else {
        // 如果无法直接提取,提示用户下载
        console.log('\n💡 无法直接提取数据,请使用插件的下载功能');
        await this.extensionCtrl.downloadData();

        await this.promptUser('下载完成后按回车继续...');
      }

      // 导出最终数据
      const stats = this.exporter.getStats();

      console.log('\n📊 采集统计:');
      console.log(`   总数据: ${stats.total} 条`);
      console.log(`   唯一数据: ${stats.unique} 条`);
      console.log(`   重复数据: ${stats.duplicates} 条\n`);

      const result = await this.exporter.export();

      console.log('\n✅ 任务完成!');

      if (result.csv) {
        console.log(`📄 CSV文件: ${result.csv}`);
      }

      if (result.json) {
        console.log(`📄 JSON文件: ${result.json}`);
      }

      // 清理
      await this.cleanup();

    } catch (error) {
      console.error('\n❌ 发生错误:', error.message);
      console.error(error.stack);

      // 保存进度
      if (this.exporter && this.exporter.collectedData.length > 0) {
        console.log('\n💾 正在保存进度...');
        await this.exporter.saveProgress({
          lastError: error.message,
          timestamp: new Date().toISOString()
        });
      }

      await this.cleanup();
      process.exit(1);
    }
  }

  /**
   * 提示用户输入
   */
  async promptUser(message) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    return new Promise((resolve) => {
      rl.question(message, () => {
        rl.close();
        resolve();
      });
    });
  }

  /**
   * 清理资源
   */
  async cleanup() {
    console.log('\n🧹 清理资源...');

    if (this.browser) {
      await this.browser.close();
    }

    console.log('✅ 清理完成');
  }
}

// 如果直接运行此文件
if (import.meta.url === `file://${process.argv[1]}`) {
  const scraper = new TwitterScraper();
  scraper.run().catch(console.error);
}

export default TwitterScraper;
