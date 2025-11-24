import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 批量任务执行器 - 管理多用户批量采集
 * 支持从数据库或JSON文件读取任务
 */
export class BatchRunner {
  constructor(scraper, config, database = null) {
    this.scraper = scraper;
    this.config = config;
    this.database = database;  // DatabaseManager 实例
    this.results = [];
    this.startTime = null;
  }

  /**
   * 从数据库加载任务列表（支持频率分组）
   * @param {number} limit - 随机抽取的用户数量
   * @param {string} frequencyGroup - 'high' | 'medium' | 'low' | 'all'
   */
  async loadTasksFromDatabase(limit = 50, frequencyGroup = 'all') {
    if (!this.database) {
      throw new Error('数据库未初始化');
    }

    console.log(`📋 从数据库加载采集任务 (频率组: ${frequencyGroup}, 随机抽取 ${limit} 个用户)...`);
    const tasks = await this.database.getPendingTasksByFrequency(frequencyGroup, limit);

    if (tasks.length === 0) {
      console.log(`⚠️  数据库中没有频率组 [${frequencyGroup}] 的待执行任务`);
      return [];
    }

    // 转换为统一格式
    const users = tasks.map(task => ({
      taskId: task.id,
      username: task.username,
      type: task.task_type,
      maxCount: task.max_count,
      enabled: task.enabled,
      frequencyGroup: task.frequency_group
    }));

    // 统计用户数
    const uniqueUsers = new Set(tasks.map(t => t.username)).size;
    console.log(`✅ 从数据库加载了 ${uniqueUsers} 个用户的 ${users.length} 个待执行任务`);
    return users;
  }

  /**
   * 加载用户列表 (兼容旧版JSON/CSV文件模式)
   */
  loadUserList(filePath) {
    const resolvedPath = path.resolve(__dirname, '../../', filePath || this.config.batch?.userListFile || './users.json');

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`用户列表文件不存在: ${resolvedPath}`);
    }

    const content = fs.readFileSync(resolvedPath, 'utf8');
    const ext = path.extname(resolvedPath).toLowerCase();

    let users;

    if (ext === '.json') {
      const data = JSON.parse(content);
      users = data.users || data;
    } else if (ext === '.csv') {
      users = this.parseCSV(content);
    } else {
      throw new Error(`不支持的文件格式: ${ext}`);
    }

    // 过滤已禁用的用户
    const enabledUsers = users.filter(u => u.enabled !== false);
    console.log(`📋 加载用户列表: ${enabledUsers.length}/${users.length} 个启用的用户`);

    return enabledUsers;
  }

  /**
   * 解析CSV格式的用户列表
   */
  parseCSV(content) {
    const lines = content.trim().split('\n');
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());

    return lines.slice(1).map(line => {
      const values = line.split(',').map(v => v.trim());
      const user = {};

      headers.forEach((header, i) => {
        let value = values[i];
        // 处理布尔值和数字
        if (value === 'true') value = true;
        else if (value === 'false') value = false;
        else if (!isNaN(value) && value !== '') value = Number(value);

        user[header] = value;
      });

      return user;
    });
  }

  /**
   * 执行批量采集 (串行模式 - 扩展限制)
   */
  async run(options = {}) {
    this.startTime = Date.now();

    console.log('╔════════════════════════════════════════╗');
    console.log('║   Twitter 批量数据采集器 (串行模式)    ║');
    console.log('╚════════════════════════════════════════╝\n');

    try {
      // 1. 加载任务列表（支持频率分组）
      let users;
      if (this.database && !options.userListFile) {
        const frequencyGroup = options.frequency || 'all';
        const limit = options.limit || 100;
        users = await this.loadTasksFromDatabase(limit, frequencyGroup);
      } else {
        console.log('📄 使用文件模式加载任务列表');
        users = this.loadUserList(options.userListFile);
      }

      // 过滤和筛选
      let pendingUsers = [...users];
      if (options.only) {
        const onlyList = options.only.split(',').map(u => u.trim().toLowerCase());
        pendingUsers = users.filter(u => onlyList.includes(u.username.toLowerCase()));
      }
      if (options.skipCompleted) {
        pendingUsers = await this.filterUncompletedUsers(pendingUsers);
      }

      const totalUsers = pendingUsers.length;
      if (totalUsers === 0) {
        console.log('⚠️  没有需要处理的用户');
        return this.generateReport();
      }

      console.log(`\n📊 将处理 ${totalUsers} 个任务\n`);

      // 2. 串行处理每个任务
      let completedCount = 0;
      for (const user of pendingUsers) {
        const taskStartTime = Date.now();

        try {
          // 更新数据库状态为running
          if (this.database && user.taskId) {
            await this.database.updateTaskStatus(user.taskId, 'running');
          }

          console.log(`\n🚀 [${completedCount + 1}/${totalUsers}] 采集任务: @${user.username} (${user.type})`);

          // 执行采集（一次性完成：配置→采集→下载→入库）
          const result = await this.scraper.collectForUser(user);

          // 记录成功结果
          this.results.push({
            username: user.username,
            type: user.type,
            status: 'success',
            dataCount: result.total || 0,
            newDataCount: result.new || 0,
            duration: Date.now() - taskStartTime
          });

          completedCount++;

          // 更新数据库状态为completed，并更新频率分组
          if (this.database && user.taskId) {
            // 更新用户发帖频率分组（自动计算下次运行时间）
            await this.database.updateUserFrequency(user.taskId, result.total || 0);

            // 更新任务状态为completed
            await this.database.updateTaskStatus(user.taskId, 'completed');
          }

          const elapsed = ((Date.now() - taskStartTime) / 1000).toFixed(1);
          console.log(`✅ 完成 (用时: ${elapsed}秒，进度: ${completedCount}/${totalUsers})`);

        } catch (error) {
          console.error(`❌ 任务失败 @${user.username}:`, error.message);

          this.results.push({
            username: user.username,
            type: user.type,
            status: 'error',
            error: error.message
          });

          if (this.database && user.taskId) {
            await this.database.updateTaskStatus(user.taskId, 'failed', error.message);
          }

          // 是否继续处理其他用户
          if (!this.config.batch?.continueOnError) {
            throw error;
          }
        }
      }

      return this.generateReport();

    } catch (error) {
      console.error('\n❌ 批量任务失败:', error.message);
      return this.generateReport(error);
    }
  }

  /**
   * 处理单个用户
   */
  async processUser(user) {
    const startTime = Date.now();
    const result = {
      taskId: user.taskId,  // 数据库任务ID
      username: user.username,
      type: user.type,
      maxCount: user.maxCount || this.config.target.maxCount,
      status: 'pending',
      error: null,
      dataCount: 0,
      newDataCount: 0,
      duration: 0
    };

    try {
      // 更新数据库任务状态为running
      if (this.database && user.taskId) {
        await this.database.updateTaskStatus(user.taskId, 'running');
      }

      // 更新scraper配置
      this.scraper.config.target = {
        username: user.username,
        type: user.type,
        maxCount: user.maxCount || this.config.target.maxCount
      };

      // 选择正确的插件
      const extensionType = this.getExtensionType(user.type);
      console.log(`🔌 使用插件: ${extensionType}`);

      // 执行采集
      const data = await this.scraper.collectForUser(user);

      result.status = 'success';
      result.dataCount = data.total || 0;
      result.newDataCount = data.new || 0;
      result.updatedDataCount = data.updated || 0;

      // 更新数据库任务状态为completed
      if (this.database && user.taskId) {
        // 计算下次运行时间 (当前时间 + 2小时)
        const nextRunTime = new Date(Date.now() + 2 * 60 * 60 * 1000);
        await this.database.updateTaskStatus(user.taskId, 'completed', null, nextRunTime);
      }

      // 优化日志输出
      if (data.new > 0 && data.updated > 0) {
        console.log(`✅ @${user.username} 采集完成: 新增 ${data.new} 条，更新 ${data.updated} 条（总计 ${data.total} 条）`);
      } else if (data.new > 0) {
        console.log(`✅ @${user.username} 采集完成: 新增 ${data.new} 条（总计 ${data.total} 条）`);
      } else if (data.updated > 0) {
        console.log(`✅ @${user.username} 采集完成: 更新 ${data.updated} 条（总计 ${data.total} 条）`);
      } else {
        console.log(`✅ @${user.username} 采集完成: 无新数据（总计 ${data.total} 条）`);
      }

    } catch (error) {
      result.status = 'error';
      result.error = error.message;
      console.error(`❌ @${user.username} 采集失败: ${error.message}`);

      // 更新数据库任务状态为failed
      if (this.database && user.taskId) {
        await this.database.updateTaskStatus(user.taskId, 'failed', error.message);
      }

      // 是否继续处理其他用户
      if (!this.config.batch?.continueOnError) {
        throw error;
      }
    }

    result.duration = Date.now() - startTime;
    return result;
  }

  /**
   * 根据数据类型获取插件类型
   */
  getExtensionType(dataType) {
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
   * 过滤未完成的用户
   */
  async filterUncompletedUsers(users) {
    // 这里可以根据历史记录判断用户是否已完成
    // 简化实现：返回所有用户
    return users;
  }

  /**
   * 生成批量执行报告
   */
  generateReport(error = null) {
    const endTime = Date.now();
    const duration = endTime - this.startTime;

    const report = {
      startTime: new Date(this.startTime).toISOString(),
      endTime: new Date(endTime).toISOString(),
      duration: `${(duration / 1000 / 60).toFixed(2)} 分钟`,
      totalUsers: this.results.length,
      successCount: this.results.filter(r => r.status === 'success').length,
      errorCount: this.results.filter(r => r.status === 'error').length,
      totalNewData: this.results.reduce((sum, r) => sum + (r.newDataCount || 0), 0),
      globalError: error ? error.message : null,
      results: this.results
    };

    // 打印报告摘要
    console.log('\n' + '═'.repeat(50));
    console.log('📊 批量任务报告');
    console.log('═'.repeat(50));
    console.log(`总用户数: ${report.totalUsers}`);
    console.log(`成功: ${report.successCount}`);
    console.log(`失败: ${report.errorCount}`);
    console.log(`新增数据: ${report.totalNewData} 条`);
    console.log(`总耗时: ${report.duration}`);
    console.log('═'.repeat(50));

    // 保存报告文件
    const reportPath = this.config.batch?.reportFile || './output/batch-report.json';
    const resolvedReportPath = path.resolve(__dirname, '../../', reportPath);

    // 确保目录存在
    const reportDir = path.dirname(resolvedReportPath);
    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }

    fs.writeFileSync(resolvedReportPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(`\n📄 报告已保存: ${resolvedReportPath}`);

    return report;
  }

  /**
   * 延迟工具函数
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default BatchRunner;
