#!/usr/bin/env node

import config from '../config.js';
import { BrowserManager } from './modules/BrowserManager.js';
import { TwitterAuth } from './modules/TwitterAuth.js';
import { ExtensionController } from './modules/ExtensionController.js';
import { DataExporter } from './modules/DataExporter.js';  // 保留用于本地调试
import { BatchRunner } from './modules/BatchRunner.js';
import { IncrementalCollector } from './modules/IncrementalCollector.js';
import { DatabaseManager } from './modules/DatabaseManager.js';
import readline from 'readline';
import path from 'path';

/**
 * 批量Twitter数据采集器 (支持数据库集成)
 */
class BatchTwitterScraper {
  constructor(userConfig = {}) {
    this.config = { ...config, ...userConfig };
    this.browser = null;
    this.auth = null;
    this.extensionCtrl = null;
    this.exporter = null;
    this.incrementalCollector = null;
    this.database = null;  // 数据库管理器
    this.isInitialized = false;
  }

  /**
   * 初始化浏览器和插件
   */
  async init() {
    if (this.isInitialized) return;

    console.log('\n🚀 Twitter 批量采集器 v3.0\n');

    // 初始化数据库 (如果配置了)
    if (this.config.database?.enabled) {
      this.database = new DatabaseManager(this.config.database);
      await this.database.init();
      console.log('✅ 数据库已连接');
    }

    // 初始化增量收集器 (传入数据库实例)
    this.incrementalCollector = new IncrementalCollector(this.config, this.database);

    // 加载扩展路径
    const tweetExtPath = path.resolve(process.cwd(), this.config.extensions.tweetExport);
    const followerExtPath = path.resolve(process.cwd(), this.config.extensions.followerExport);

    // 初始化浏览器管理器
    this.browser = new BrowserManager(this.config);

    // 启动浏览器并同时加载两个插件
    await this.browser.launch([tweetExtPath, followerExtPath]);

    // 初始化认证模块
    this.auth = new TwitterAuth(this.browser, this.config.twitter);

    // 初始化插件控制器
    this.extensionCtrl = new ExtensionController(this.browser, this.config);

    // 初始化数据导出器
    this.exporter = new DataExporter(this.config);

    console.log('✅ 浏览器和扩展已加载\n');
    this.isInitialized = true;
  }

  /**
   * 确保已登录
   */
  async ensureLoggedIn() {
    console.log('🔐 检查登录状态...');
    const isLoggedIn = await this.auth.isAlreadyLoggedIn();

    if (!isLoggedIn) {
      console.log('⚠️ 未检测到登录状态，尝试登录...');

      // 检查是否配置了自动登录凭据 (config.js 或 环境变量)
      if (this.config.twitter.username && this.config.twitter.password) {
        console.log('🤖 检测到账号配置，尝试自动登录...');
        await this.auth.login();
        
        // 再次验证
        const nowLoggedIn = await this.auth.verifyLogin();
        if (!nowLoggedIn) {
            throw new Error('自动登录尝试失败，请检查账号密码或验证步骤');
        }
        console.log('✅ 自动登录成功');
      } else {
        // 手动登录模式 (仅在非 CI 环境下提示)
        if (process.env.CI) {
            throw new Error('CI 环境下必须配置 TWITTER_USERNAME 和 TWITTER_PASSWORD 环境变量以自动登录');
        }

        console.log('\n⚠️  未检测到登录状态，且未配置账号信息');
        console.log('📝 请在浏览器中手动登录Twitter...');
        console.log('💡 登录成功后，按回车键继续\n');

        // 导航到登录页
        await this.browser.goto('https://twitter.com/login');

        // 等待用户手动登录
        await this.promptUser('登录完成后按回车继续...');

        // 验证登录状态
        const nowLoggedIn = await this.auth.isAlreadyLoggedIn();
        if (!nowLoggedIn) {
          throw new Error('登录验证失败，请确保已成功登录');
        }
        console.log('✅ 手动登录成功！登录状态已保存，下次运行无需重新登录');
      }
    } else {
      console.log('✅ 已登录');
    }
    
    // 无论何种方式登录成功，在本地环境下都导出 Cookies，方便配置到 GitHub Secrets
    if (!process.env.CI) {
        await this.auth.exportCookies();
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
   * 为单个用户采集数据 (串行模式优化版)
   */
  async collectForUser(user) {
    const { username, type, maxCount } = user;

    // 1. 自动配置插件（传入username和type）
    await this.extensionCtrl.autoConfigureExtension(type, maxCount, username);

    // 2. 开始导出并监控进度
    const dashboardPage = await this.extensionCtrl.startExport();
    if (!dashboardPage) {
      throw new Error('无法启动导出');
    }

    // 3. 监控进度（传入dashboard页面和目标数量）
    await this.extensionCtrl.monitorProgress(dashboardPage, maxCount);

    // 4. 点击导出按钮下载数据
    await this.extensionCtrl.clickExportButton(dashboardPage);

    // 等待下载开始
    await this.sleep(1000);

    // 5. 读取下载的文件
    let rawData = await this.readDownloadedFile(username, type);
    console.log(`📊 读取到 ${rawData.length} 条原始数据`);

    // 6. 关闭dashboard页面
    try {
      await dashboardPage.close();
    } catch (e) {
      // 忽略关闭错误
    }

    // 7. 增量处理 - 合并新旧数据（数据已入库）
    const result = await this.incrementalCollector.processCollectedData(username, type, rawData);

    // ✅ 数据已入库，不再导出 CSV/JSON 文件

    return result;
  }

  /**
   * 读取下载的文件
   */
  async readDownloadedFile(username, type) {
    const fs = await import('fs');
    const path = await import('path');

    // 默认下载路径（Chrome）
    const downloadDir = path.join(process.env.HOME || process.env.USERPROFILE, 'Downloads');

    // 确保 Downloads 目录存在（CI 环境可能没有）
    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true });
      console.log(`📁 创建下载目录: ${downloadDir}`);
    }

    // 可能的文件名模式（扩展可能使用不同的命名）
    // TwExport 格式: TwExport_{username}_{Type}.csv (Type 首字母大写)
    const typeCapitalized = type.charAt(0).toUpperCase() + type.slice(1);
    const possiblePatterns = [
      `TwExport_${username}_${typeCapitalized}`,  // TwExport_username_Posts
      `TwExport_${username}_${type}`,              // TwExport_username_posts
      `${username}_${type}`,
      `${username}-${type}`,
      `twitter_${username}_${type}`,
      `export_${username}_${type}`,
      username
    ];

    // 轮询查找文件（最多等待 10 秒）
    const maxRetries = 10;
    for (let retry = 0; retry < maxRetries; retry++) {
      try {
        const files = fs.readdirSync(downloadDir);

        // 按修改时间排序，查找最近1分钟内的文件
        const recentFiles = files
          .map(file => ({
            name: file,
            path: path.join(downloadDir, file),
            time: fs.statSync(path.join(downloadDir, file)).mtime.getTime()
          }))
          .filter(file => {
            // 只看最近1分钟内的文件
            const now = Date.now();
            return (now - file.time) < 60000;
          })
          .filter(file => {
            // 匹配CSV或JSON文件
            return file.name.endsWith('.csv') || file.name.endsWith('.json');
          })
          .sort((a, b) => b.time - a.time);

        // 尝试匹配用户名
        const matchedFiles = recentFiles.filter(file => {
          const nameLower = file.name.toLowerCase();
          return possiblePatterns.some(pattern => nameLower.includes(pattern.toLowerCase()));
        });

        if (matchedFiles.length > 0) {
          const targetFile = matchedFiles[0];
          console.log(`📂 读取下载文件: ${targetFile.name}`);

          // 读取文件内容
          const content = fs.readFileSync(targetFile.path, 'utf8');

          let data;
          if (targetFile.name.endsWith('.json')) {
            data = JSON.parse(content);
          } else if (targetFile.name.endsWith('.csv')) {
            data = await this.parseCSV(content);
          }

          // 验证数据有效性
          if (data && Array.isArray(data) && data.length > 0) {
            console.log(`✅ 成功读取 ${data.length} 条数据`);
            return data;
          } else {
            console.warn(`⚠️  文件内容无效，重试 ${retry + 1}/${maxRetries}...`);
          }
        }

        // 等待 1 秒后重试
        if (retry < maxRetries - 1) {
          await this.sleep(1000);
        }

      } catch (error) {
        console.warn(`⚠️  读取下载文件失败 (${retry + 1}/${maxRetries}): ${error.message}`);
        if (retry < maxRetries - 1) {
          await this.sleep(1000);
        }
      }
    }

    // 所有重试都失败，放弃
    console.error('❌ 无法读取下载文件，数据丢失！');
    throw new Error('Failed to read downloaded file after multiple retries');
  }

  /**
   * 解析CSV文件
   */
  async parseCSV(content) {
    try {
      // 动态导入 csv-parse（ES 模块）
      const { parse } = await import('csv-parse/sync');

      // 使用 csv-parse 库正确解析 CSV（处理引号、换行符等）
      const records = parse(content, {
        columns: true,           // 第一行作为列名
        skip_empty_lines: true,  // 跳过空行
        relax_quotes: true,      // 放松引号检查
        trim: true,              // 去除空白
        bom: true                // 处理 BOM（UTF-8 标记）
      });

      return records;
    } catch (error) {
      console.error('❌ CSV 解析失败:', error.message);

      // 降级到简单解析（仅用于调试）
      const lines = content.trim().split('\n');
      if (lines.length < 2) return [];

      const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
      const data = [];

      for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(',').map(v => v.trim().replace(/^"|"$/g, ''));
        const row = {};
        headers.forEach((header, index) => {
          row[header] = values[index] || '';
        });
        data.push(row);
      }

      return data;
    }
  }

  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 运行批量采集任务
   */
  async runBatch(options = {}) {
    try {
      await this.init();
      await this.ensureLoggedIn();

      const batchRunner = new BatchRunner(this, this.config, this.database);
      const report = await batchRunner.run(options);

      return report;

    } catch (error) {
      console.error('\n❌ 批量任务失败:', error.message);
      throw error;
    } finally {
      await this.cleanup();
    }
  }

  /**
   * 采集单个用户 (独立运行模式)
   */
  async runSingle(username, type, maxCount = null) {
    try {
      await this.init();
      await this.ensureLoggedIn();

      const result = await this.collectForUser({ username, type, maxCount });

      console.log('\n✅ 采集完成!');
      console.log(`   总数据: ${result.total} 条`);
      console.log(`   新数据: ${result.new} 条`);
      console.log(`   重复数据: ${result.total - result.new} 条`);

      return result;

    } catch (error) {
      console.error('\n❌ 采集失败:', error.message);
      throw error;
    } finally {
      await this.cleanup();
    }
  }

  /**
   * 清理资源
   */
  async cleanup() {
    console.log('\n🧹 清理资源...');

    // 关闭数据库连接
    if (this.database) {
      await this.database.close();
    }

    // 关闭浏览器
    if (this.browser) {
      await this.browser.close();
    }

    this.isInitialized = false;

    // ✅ Chrome Profile 已废弃，改用 Cookie 方案，无需精简

    console.log('✅ 清理完成');
  }
}

// 命令行参数解析
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {};

  for (const arg of args) {
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      options[key] = value || true;
    }
  }

  return options;
}

// 显示帮助信息
function showHelp() {
  console.log(`
Twitter批量采集器 - 使用说明

用法:
  npm run batch                    # 执行批量采集 (读取数据库任务)
  npm run batch -- --help          # 显示帮助信息

选项:
  --users=<file>                   # 指定用户列表文件 (默认: ./users.json)
  --only=<user1,user2>             # 只处理指定的用户
  --skip-completed                 # 跳过已完成的用户
  --batch-size=<number>            # 批次大小，随机抽取N个用户 (默认: 50)
  --frequency=<group>              # 频率分组: all/high/medium/low (默认: all)
  --single=<username>              # 单用户模式
  --type=<posts|replies>           # 单用户模式的数据类型
  --count=<number>                 # 采集数量限制
  --login-only                     # 仅执行登录操作并退出（用于 CI 环境刷新 Profile）

频率分组说明:
  high   - 高频用户 (每2小时, 北京时间8-24点)
  medium - 中频用户 (每4小时, 北京时间8-24点)
  low    - 低频用户 (每6小时, 北京时间8-24点)
  all    - 所有分组

示例:
  npm run batch -- --batch-size=20 --frequency=high
  npm run batch -- --only=elonmusk,sama
  npm run batch -- --single=elonmusk --type=posts --count=100
`);
}

// 主入口
async function main() {
  const options = parseArgs();

  if (options.help) {
    showHelp();
    process.exit(0);
  }

  const scraper = new BatchTwitterScraper();

  try {
    if (options['login-only']) {
        // 仅登录模式
        console.log('🚀 启动仅登录模式 (Login Only Mode)...');
        await scraper.init();
        await scraper.ensureLoggedIn();
        console.log('✅ 登录检查完成，正在退出...');
        await scraper.cleanup();
        process.exit(0);
    } else if (options.single) {
      // 单用户模式
      const type = options.type || 'posts';
      const count = options.count ? parseInt(options.count) : null;
      await scraper.runSingle(options.single, type, count);
    } else {
      // 批量模式
      await scraper.runBatch({
        userListFile: options.users,
        only: options.only,
        skipCompleted: options['skip-completed'],
        limit: options['batch-size'] ? parseInt(options['batch-size']) : 50,
        frequency: options.frequency || 'all'  // 新增：频率分组
      });
    }
  } catch (error) {
    console.error('程序异常退出:', error.message);
    process.exit(1);
  }
}

// 运行
main();

export default BatchTwitterScraper;
