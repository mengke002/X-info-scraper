// 配置文件
export default {
  // 数据库配置 (v3.0新增)
  database: {
    enabled: true,  // 默认启用数据库集成
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === 'true',
    // 注意: 也支持 DATABASE_URL 环境变量 (优先级更高)
    // DATABASE_URL 格式: mysql://user:pass@host:port/dbname?ssl-mode=REQUIRED
  },

  // Chrome插件路径
  extensions: {
    followerExport: '../Twitter Export Follower/3.8.0_0',
    tweetExport: '../TwExport/2.6.0_0'
  },

  // Twitter账号信息
  twitter: {
    username: '',  // 你的Twitter用户名或邮箱
    password: '',  // 你的Twitter密码
    // phone: '',  // 如果需要手机验证,填写手机号
  },

  // 采集目标 (单用户模式使用)
  target: {
    username: '',  // 要采集的目标用户名 (例如: 'elonmusk')
    type: 'posts',  // 'followers' | 'following' | 'posts' | 'replies'
    maxCount: 100,  // null = 无限制, 或设置具体数字
  },

  // 批量采集配置
  batch: {
    userListFile: './users.json',  // 用户列表文件路径 (数据库模式下可选)
    historyDir: './data/history',  // 增量采集历史记录目录 (已弃用,使用数据库)
    continueOnError: true,  // 单个用户失败时是否继续处理其他用户
    userDelay: 10000,  // 用户间延迟(毫秒)，建议10-30秒
    reportFile: './output/batch-report.json',  // 批量执行报告文件
  },

  // 浏览器配置
  browser: {
    // 在 CI 环境下:
    // 1. 如果使用 XVFB (USE_XVFB=true)，则必须关闭 headless (因为有虚拟屏幕)
    // 2. 否则使用 'new' 模式的 headless
    headless: process.env.USE_XVFB === 'true' ? false : (process.env.HEADLESS === 'true' ? 'new' : false),
    slowMo: 50,  // 减慢操作速度(毫秒),更像真人
    viewport: {
      width: 1920,
      height: 1080
    },
    userDataDir: './data/chrome-profile',  // 保存会话,避免重复登录
  },

  // 反检测配置
  stealth: {
    enabled: true,  // 启用stealth模式
    randomDelay: [500, 2000],  // 随机延迟范围(毫秒)
    humanBehavior: true,  // 模拟人类行为(鼠标移动等)
  },

  // 速率限制(保护账号安全)
  rateLimit: {
    requestDelay: 1000,  // 每次请求间隔(毫秒)
    batchSize: 100,  // 每批处理数量
    batchDelay: 5000,  // 每批之间的延迟(毫秒)
    maxRetries: 3,  // 最大重试次数
  },

  // 数据导出配置
  output: {
    format: 'both',  // 'csv' | 'json' | 'both'
    directory: './output',
    filename: null,  // null = 自动生成 (格式: target_type_timestamp)
    deduplicate: true,  // 去重
  },

  // 日志配置
  logging: {
    level: 'info',  // 'debug' | 'info' | 'warn' | 'error'
    saveToFile: true,
    directory: './logs'
  }
};
