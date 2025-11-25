import mysql from 'mysql2/promise';

/**
 * 数据库管理器
 * 负责与MySQL数据库交互,管理采集任务和数据存储
 */
export class DatabaseManager {
  constructor(config = {}) {
    this.config = this.parseConfig(config);
    this.pool = null;
  }

  /**
   * 解析数据库配置
   * 支持 DATABASE_URL 或单独的环境变量
   */
  parseConfig(config) {
    // 优先使用 DATABASE_URL (GitHub Actions secrets)
    const dbUrl = process.env.DATABASE_URL;

    if (dbUrl) {
      // 解析 mysql://user:pass@host:port/dbname?ssl-mode=REQUIRED
      const urlPattern = /mysql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/([^?]+)(\?.*)?/;
      const match = dbUrl.match(urlPattern);

      if (match) {
        const [, user, password, host, port, database, params] = match;
        return {
          host,
          port: parseInt(port),
          user,
          password,
          database,
          charset: 'utf8mb4',
          waitForConnections: true,
          connectionLimit: 10,
          queueLimit: 0,
          ssl: params && params.includes('ssl-mode=REQUIRED')
            ? { rejectUnauthorized: false }
            : undefined
        };
      }
    }

    // 使用单独的环境变量或配置对象
    return {
      host: config.host || process.env.DB_HOST || 'localhost',
      port: config.port || parseInt(process.env.DB_PORT || '3306'),
      user: config.user || process.env.DB_USER || 'root',
      password: config.password || process.env.DB_PASSWORD || '',
      database: config.database || process.env.DB_NAME || 'twitter_data',
      charset: 'utf8mb4',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      ssl: config.ssl || (process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined)
    };
  }

  /**
   * 初始化数据库连接池
   */
  async init() {
    if (this.pool) return;

    try {
      this.pool = mysql.createPool(this.config);

      // 测试连接
      const connection = await this.pool.getConnection();
      console.log('✅ 数据库连接成功');
      connection.release();
    } catch (error) {
      console.error('❌ 数据库连接失败:', error.message);
      throw error;
    }
  }

  /**
   * 获取数据库连接
   */
  async getConnection() {
    if (!this.pool) {
      await this.init();
    }
    return await this.pool.getConnection();
  }

  /**
   * 关闭数据库连接池
   */
  async close() {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      console.log('✅ 数据库连接已关闭');
    }
  }

  // ========== 任务管理 ==========

  /**
   * 获取待执行的任务 (先随机抽取用户，再获取这些用户的所有任务)
   * @param {number} userLimit - 最大用户数
   * @returns {Promise<Array>} 任务列表
   */
  async getPendingTasks(userLimit = 50) {
    const connection = await this.getConnection();

    try {
      // 第一步：随机选择 N 个待执行的用户（去重）
      const [userRows] = await connection.query(
        `SELECT DISTINCT username FROM scrape_tasks
         WHERE enabled = TRUE
         AND status != 'running'
         AND (next_run_at IS NULL OR next_run_at <= NOW())
         ORDER BY RAND()
         LIMIT ?`,
        [userLimit]
      );

      if (userRows.length === 0) {
        return [];
      }

      // 提取用户名列表
      const usernames = userRows.map(row => row.username);

      // 第二步：获取这些用户的所有待执行任务
      const placeholders = usernames.map(() => '?').join(',');
      const [taskRows] = await connection.query(
        `SELECT * FROM scrape_tasks
         WHERE enabled = TRUE
         AND status != 'running'
         AND (next_run_at IS NULL OR next_run_at <= NOW())
         AND username IN (${placeholders})
         ORDER BY username, task_type`,
        usernames
      );

      return taskRows;
    } finally {
      connection.release();
    }
  }

  /**
   * 更新任务状态和下次运行时间
   * @param {number} taskId - 任务ID
   * @param {string} status - 新状态
   * @param {string} errorMessage - 错误信息
   * @param {Date} nextRunAt - 下次运行时间
   */
  async updateTaskStatus(taskId, status, errorMessage = null, nextRunAt = null) {
    const connection = await this.getConnection();

    try {
      let sql = `UPDATE scrape_tasks
         SET status = ?,
             last_run_at = NOW(),
             error_message = ?,
             updated_at = NOW()`;
      
      const params = [status, errorMessage];

      if (nextRunAt) {
        sql += `, next_run_at = ?`;
        params.push(nextRunAt);
      }

      sql += ` WHERE id = ?`;
      params.push(taskId);

      await connection.query(sql, params);
    } finally {
      connection.release();
    }
  }

  /**
   * 添加或更新任务
   * @param {string} username - 用户名
   * @param {string} taskType - 任务类型
   * @param {number} maxCount - 最大采集数量
   */
  async upsertTask(username, taskType, maxCount = null) {
    const connection = await this.getConnection();

    try {
      await connection.query(
        `INSERT INTO scrape_tasks (username, task_type, max_count, enabled)
         VALUES (?, ?, ?, TRUE)
         ON DUPLICATE KEY UPDATE
           max_count = VALUES(max_count),
           enabled = TRUE,
           status = 'pending',
           updated_at = NOW()`,
        [username, taskType, maxCount]
      );
    } finally {
      connection.release();
    }
  }

  // ========== 用户管理 ==========

  /**
   * 插入或更新用户信息
   * @param {object} userData - 用户数据
   * @returns {Promise<number>} 用户ID
   */
  async upsertUser(userData) {
    const connection = await this.getConnection();

    try {
      const [result] = await connection.query(
        `INSERT INTO twitter_users
         (username, user_id, name, bio, location, website, verified, is_blue_verified,
          followers_count, following_count, tweets_count, avatar_url, banner_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           user_id = VALUES(user_id),
           name = VALUES(name),
           bio = VALUES(bio),
           location = VALUES(location),
           website = VALUES(website),
           verified = VALUES(verified),
           is_blue_verified = VALUES(is_blue_verified),
           followers_count = VALUES(followers_count),
           following_count = VALUES(following_count),
           tweets_count = VALUES(tweets_count),
           avatar_url = VALUES(avatar_url),
           banner_url = VALUES(banner_url),
           updated_at = CURRENT_TIMESTAMP`,
        [
          userData.Username || userData.username,
          userData['User ID'] || userData.user_id,
          userData.Name || userData.name,
          userData.Bio || userData.bio,
          userData.Location || userData.location,
          userData.Website || userData.website,
          userData.Verified || userData.verified || false,
          userData['Is Blue Verified'] || userData.is_blue_verified || false,
          userData['Followers Count'] || userData.followers_count || 0,
          userData['Following Count'] || userData.following_count || 0,
          userData['Tweets Count'] || userData.tweets_count || 0,
          userData['Avatar URL'] || userData.avatar_url,
          userData['Profile Banner URL'] || userData.banner_url
        ]
      );

      // 返回用户ID (insertId 或查询现有ID)
      if (result.insertId) {
        return result.insertId;
      }

      return await this.getUserIdByUsername(userData.Username || userData.username);
    } finally {
      connection.release();
    }
  }

  /**
   * 根据用户名获取用户ID
   * @param {string} username - 用户名
   * @returns {Promise<number|null>} 用户ID
   */
  async getUserIdByUsername(username) {
    const connection = await this.getConnection();

    try {
      const [rows] = await connection.query(
        'SELECT id FROM twitter_users WHERE username = ?',
        [username]
      );

      return rows.length > 0 ? rows[0].id : null;
    } finally {
      connection.release();
    }
  }

  // ========== 推文管理 ==========

  /**
   * 批量插入或更新推文
   * @param {Array} postsData - 推文数据数组
   * @param {number} userId - 用户ID
   * @returns {Promise<number>} 导入的记录数
   */
  async batchUpsertPosts(postsData, userId) {
    if (!postsData || postsData.length === 0) return 0;

    const connection = await this.getConnection();
    const batchSize = 1000;
    let totalImported = 0;

    try {
      // 分批处理
      for (let i = 0; i < postsData.length; i += batchSize) {
        const batch = postsData.slice(i, i + batchSize);
        const values = batch.map(post => [
          post.ID || post.tweet_id || post.id,
          userId,
          post.in_reply_to_tweet_id || null, // 新增
          post.conversation_id || null,      // 新增
          post.Text || post.text,
          post.Language || post.language,
          post.Type || post.type,
          this.parseNumber(post['View Count'] || post.view_count),
          this.parseNumber(post['Reply Count'] || post.reply_count),
          this.parseNumber(post['Retweet Count'] || post.retweet_count),
          this.parseNumber(post['Quote Count'] || post.quote_count),
          this.parseNumber(post['Favorite Count'] || post.favorite_count),
          this.parseNumber(post['Bookmark Count'] || post.bookmark_count),
          this.parseDateTime(post['Created At'] || post.published_at),
          post['Tweet URL'] || post.tweet_url,
          post.Source || post.source,
          post.hashtags,
          post.urls,
          post.media_type,
          post.media_urls
        ]);

        const placeholders = values.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
        const flatValues = values.flat();

        await connection.query(
          `INSERT INTO twitter_posts
           (tweet_id, user_id, in_reply_to_tweet_id, conversation_id, text, language, type, view_count, reply_count,
            retweet_count, quote_count, favorite_count, bookmark_count,
            published_at, tweet_url, source, hashtags, urls, media_type, media_urls)
           VALUES ${placeholders}
           ON DUPLICATE KEY UPDATE
             user_id = VALUES(user_id),
             in_reply_to_tweet_id = COALESCE(VALUES(in_reply_to_tweet_id), twitter_posts.in_reply_to_tweet_id),
             conversation_id = COALESCE(VALUES(conversation_id), twitter_posts.conversation_id),
             text = VALUES(text),
             language = VALUES(language),
             type = VALUES(type),
             view_count = VALUES(view_count),
             reply_count = VALUES(reply_count),
             retweet_count = VALUES(retweet_count),
             quote_count = VALUES(quote_count),
             favorite_count = VALUES(favorite_count),
             bookmark_count = VALUES(bookmark_count),
             published_at = VALUES(published_at),
             tweet_url = VALUES(tweet_url),
             source = VALUES(source),
             hashtags = VALUES(hashtags),
             urls = VALUES(urls),
             media_type = VALUES(media_type),
             media_urls = VALUES(media_urls),
             updated_at = CURRENT_TIMESTAMP`,
          flatValues
        );

        totalImported += batch.length;
      }

      return totalImported;
    } finally {
      connection.release();
    }
  }

  /**
   * 批量插入或更新用户信息 (用于Following导入)
   * @param {Array} usersData - 用户数据数组
   * @returns {Promise<Object>} Twitter UserID 到 内部 ID 的映射
   */
  async batchUpsertUsers(usersData) {
    if (!usersData || usersData.length === 0) return {};

    const connection = await this.getConnection();
    const batchSize = 500;

    try {
      for (let i = 0; i < usersData.length; i += batchSize) {
        const batch = usersData.slice(i, i + batchSize);
        const values = batch.map(user => [
          user.Username || user.username,
          user['User ID'] || user.user_id,
          user.Name || user.name,
          user.Bio || user.bio,
          user.Location || user.location,
          user.Website || user.website,
          this.parseBoolean(user.Verified || user.verified),
          this.parseBoolean(user['Is Blue Verified'] || user.is_blue_verified),
          this.parseNumber(user['Followers Count'] || user.followers_count),
          this.parseNumber(user['Following Count'] || user.following_count),
          this.parseNumber(user['Tweets Count'] || user.tweets_count),
          user['Avatar URL'] || user.avatar_url,
          user['Profile Banner URL'] || user.banner_url
        ]);

        const placeholders = values.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
        const flatValues = values.flat();

        await connection.query(
          `INSERT INTO twitter_users
           (username, user_id, name, bio, location, website, verified, is_blue_verified,
            followers_count, following_count, tweets_count, avatar_url, banner_url)
           VALUES ${placeholders}
           ON DUPLICATE KEY UPDATE
             user_id = VALUES(user_id),
             name = VALUES(name),
             bio = VALUES(bio),
             location = VALUES(location),
             website = VALUES(website),
             verified = VALUES(verified),
             is_blue_verified = VALUES(is_blue_verified),
             followers_count = VALUES(followers_count),
             following_count = VALUES(following_count),
             tweets_count = VALUES(tweets_count),
             avatar_url = VALUES(avatar_url),
             banner_url = VALUES(banner_url),
             updated_at = CURRENT_TIMESTAMP`,
          flatValues
        );
      }

      // 构建并返回 ID 映射
      const twitterIds = usersData.map(u => u['User ID'] || u.user_id).filter(id => id);
      if (twitterIds.length === 0) return {};

      // 分批查询 ID 映射
      const idMap = {};
      for (let i = 0; i < twitterIds.length; i += 1000) {
        const batchIds = twitterIds.slice(i, i + 1000);
        const [rows] = await connection.query(
          'SELECT id, user_id FROM twitter_users WHERE user_id IN (?)',
          [batchIds]
        );
        rows.forEach(row => {
          idMap[row.user_id] = row.id;
        });
      }

      return idMap;

    } finally {
      connection.release();
    }
  }

  /**
   * 批量插入关注关系 (新版 twitter_followings)
   * @param {number} sourceUserId - 主用户内部ID
   * @param {Array} targetInternalIds - 目标用户内部ID数组
   */
  async batchInsertFollowings(sourceUserId, targetInternalIds) {
    if (!targetInternalIds || targetInternalIds.length === 0) return 0;

    const connection = await this.getConnection();
    const batchSize = 5000;
    let totalInserted = 0;

    try {
      for (let i = 0; i < targetInternalIds.length; i += batchSize) {
        const batch = targetInternalIds.slice(i, i + batchSize);
        const values = batch.map(targetId => [sourceUserId, targetId]);
        const flatValues = values.flat();
        const placeholders = values.map(() => '(?,?)').join(',');

        const [result] = await connection.query(
          `INSERT IGNORE INTO twitter_followings (source_user_id, target_user_id) VALUES ${placeholders}`,
          flatValues
        );
        totalInserted += result.affectedRows;
      }
      return totalInserted;
    } finally {
      connection.release();
    }
  }

  /**
   * 获取已采集的推文ID列表
   * @param {number} userId - 用户ID
   * @returns {Promise<Set>} 推文ID集合
   */
  async getCollectedPostIds(userId) {
    const connection = await this.getConnection();

    try {
      const [rows] = await connection.query(
        'SELECT tweet_id FROM twitter_posts WHERE user_id = ?',
        [userId]
      );

      return new Set(rows.map(row => row.tweet_id));
    } finally {
      connection.release();
    }
  }

  // ========== 关注关系管理 ==========

  /**
   * 批量插入或更新关注关系
   * @param {Array} followersData - 关注者数据数组
   * @param {number} userId - 被关注者用户ID
   * @param {string} relationType - 关系类型 (follower/following)
   * @returns {Promise<number>} 导入的记录数
   */
  async batchUpsertFollowers(followersData, userId, relationType) {
    if (!followersData || followersData.length === 0) return 0;

    const connection = await this.getConnection();
    const batchSize = 1000;
    let totalImported = 0;

    try {
      // 分批处理
      for (let i = 0; i < followersData.length; i += batchSize) {
        const batch = followersData.slice(i, i + batchSize);
        const values = batch.map(follower => [
          userId,
          follower['User ID'] || follower.user_id,
          follower.Username || follower.username,
          follower.Name || follower.name,
          follower.Bio || follower.bio,
          this.parseBoolean(follower.Verified || follower.verified),
          this.parseNumber(follower['Followers Count'] || follower.followers_count),
          follower['Avatar URL'] || follower.avatar_url,
          relationType
        ]);

        const placeholders = values.map(() => '(?,?,?,?,?,?,?,?,?)').join(',');
        const flatValues = values.flat();

        await connection.query(
          `INSERT INTO twitter_followers
           (user_id, follower_user_id, follower_username, follower_name, follower_bio,
            follower_verified, follower_followers_count, follower_avatar_url, relation_type)
           VALUES ${placeholders}
           ON DUPLICATE KEY UPDATE
             follower_name = VALUES(follower_name),
             follower_bio = VALUES(follower_bio),
             follower_verified = VALUES(follower_verified),
             follower_followers_count = VALUES(follower_followers_count),
             follower_avatar_url = VALUES(follower_avatar_url),
             updated_at = CURRENT_TIMESTAMP`,
          flatValues
        );

        totalImported += batch.length;
      }

      return totalImported;
    } finally {
      connection.release();
    }
  }

  /**
   * 获取已采集的关注关系ID列表
   * @param {number} userId - 用户ID
   * @param {string} relationType - 关系类型
   * @returns {Promise<Set>} 关注者user_id集合
   */
  async getCollectedFollowerIds(userId, relationType) {
    const connection = await this.getConnection();

    try {
      const [rows] = await connection.query(
        'SELECT follower_user_id FROM twitter_followers WHERE user_id = ? AND relation_type = ?',
        [userId, relationType]
      );

      return new Set(rows.map(row => row.follower_user_id));
    } finally {
      connection.release();
    }
  }

  // ========== 工具方法 ==========

  /**
   * 解析数字
   */
  parseNumber(value) {
    if (value === null || value === undefined || value === '') return 0;
    const num = parseInt(value);
    return isNaN(num) ? 0 : num;
  }

  /**
   * 解析布尔值
   */
  parseBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.toLowerCase() === 'true';
    return false;
  }

  /**
   * 解析日期时间
   */
  parseDateTime(value) {
    if (!value) return null;

    try {
      // 支持多种日期格式
      const date = new Date(value);
      if (isNaN(date.getTime())) return null;

      // 转换为 MySQL DATETIME 格式
      return date.toISOString().slice(0, 19).replace('T', ' ');
    } catch (error) {
      return null;
    }
  }

  // ========== 用户频率分组管理 ==========

  /**
   * 获取指定频率组的待执行任务（随机抽取）
   * @param {string} frequencyGroup - 'high' | 'medium' | 'low' | 'all'
   * @param {number} limit - 随机抽取的用户数量
   * @returns {Promise<Array>} 任务列表
   */
  async getPendingTasksByFrequency(frequencyGroup = 'all', limit = 20) {
    const connection = await this.getConnection();

    try {
      const now = new Date();

      // 构建 WHERE 条件
      let whereClause = `
        WHERE enabled = TRUE
        AND status != 'running'
        AND (next_run_time IS NULL OR next_run_time <= ?)
      `;

      const params = [now];

      // 添加频率组过滤
      if (frequencyGroup !== 'all') {
        whereClause += ` AND frequency_group = ?`;
        params.push(frequencyGroup);
      }

      // 第一步：随机选择用户
      const userQuery = `
        SELECT DISTINCT username FROM scrape_tasks
        ${whereClause}
        ORDER BY RAND()
        LIMIT ?
      `;
      params.push(limit);

      const [userRows] = await connection.query(userQuery, params);

      if (userRows.length === 0) {
        console.log(`⚠️  没有找到频率组 [${frequencyGroup}] 的待执行任务`);
        return [];
      }

      // 提取用户名列表
      const usernames = userRows.map(row => row.username);
      console.log(`✅ 找到 ${usernames.length} 个用户 (频率组: ${frequencyGroup})`);

      // 第二步：获取这些用户的所有任务
      const placeholders = usernames.map(() => '?').join(',');
      const taskQuery = `
        SELECT * FROM scrape_tasks
        WHERE enabled = TRUE
        AND status != 'running'
        AND username IN (${placeholders})
      `;

      const [taskRows] = await connection.query(taskQuery, usernames);
      return taskRows;

    } finally {
      connection.release();
    }
  }

  /**
   * 更新用户发帖频率分组
   * @param {number} taskId - 任务ID
   * @param {number} totalPostCount - 采集到的总推文数
   */
  async updateUserFrequency(taskId, totalPostCount) {
    const connection = await this.getConnection();

    try {
      // 1. 获取任务的历史数据（包括 task_type）
      const [rows] = await connection.query(
        `SELECT task_type, last_post_count, last_run_at, updated_at, frequency_group, avg_posts_per_day
         FROM scrape_tasks
         WHERE id = ?`,
        [taskId]
      );

      if (rows.length === 0) {
        console.warn(`⚠️  任务 ID ${taskId} 不存在`);
        return;
      }

      const task = rows[0];
      const taskType = task.task_type;

      // 🔥 核心改动：只有 posts 任务才计算动态频率
      // replies/followers/following 任务使用固定的低频策略
      if (taskType !== 'posts') {
        const nextRunHours = 18; // 固定 18 小时间隔
        const nextRunTime = this.calculateNextRunTime(nextRunHours);

        await connection.query(
          `UPDATE scrape_tasks
           SET frequency_group = 'low',
               last_post_count = ?,
               next_run_time = ?
           WHERE id = ?`,
          ['low', totalPostCount, nextRunTime, taskId]
        );

        console.log(`📊 频率更新: low (${taskType} 固定策略, 间隔 18h, 下次: ${nextRunTime})`);
        return;
      }

      // 以下是 posts 任务的动态频率计算逻辑
      const lastCount = task.last_post_count || 0;

      // 使用 last_run_at 而非 updated_at 来计算时间间隔（更准确）
      const lastRunTime = task.last_run_at ? new Date(task.last_run_at) : null;

      // 2. 计算新增帖子数
      const newPosts = Math.max(0, totalPostCount - lastCount);

      // 3. 计算平均发帖速率（使用加权移动平均，避免极端值）
      let avgPostsPerDay;

      if (!lastRunTime || lastCount === 0) {
        // 首次采集：使用保守的默认值 2（medium_high级别）
        avgPostsPerDay = task.avg_posts_per_day || 2;
      } else {
        const daysSinceLastRun = (Date.now() - lastRunTime.getTime()) / (1000 * 60 * 60 * 24);

        if (daysSinceLastRun < 0.04) {
          // 间隔小于 1 小时（0.04天）：完全使用历史值，忽略本次计算
          avgPostsPerDay = task.avg_posts_per_day || 2;
        } else if (daysSinceLastRun < 0.5) {
          // 间隔小于 12 小时：加权平均（历史值权重 70%）
          const currentRate = newPosts / daysSinceLastRun;
          const historicalRate = task.avg_posts_per_day || 2;
          avgPostsPerDay = historicalRate * 0.7 + currentRate * 0.3;
        } else {
          // 间隔超过 12 小时：正常计算，但仍做加权平均（历史值权重 30%）
          const currentRate = newPosts / daysSinceLastRun;
          const historicalRate = task.avg_posts_per_day || currentRate;
          avgPostsPerDay = historicalRate * 0.3 + currentRate * 0.7;
        }

        // 限制极端值范围 [0, 100]
        avgPostsPerDay = Math.max(0, Math.min(100, avgPostsPerDay));
      }

      // 4. 根据发帖速率确定频率分组（基于真实数据分析优化后的阈值）
      // 阈值调整依据：分析了 243 个用户的历史推文数据
      // - 中位数: 1.64 posts/天
      // - 75% 分位: 4.10 posts/天
      // - 90% 分位: 7.21 posts/天
      let frequencyGroup = 'medium';

      if (avgPostsPerDay >= 7) {
        // Top 10% 高频用户：≥7 posts/天
        frequencyGroup = 'very_high';
      } else if (avgPostsPerDay >= 3.5) {
        // Top 30% 中高频用户：3.5-7 posts/天
        frequencyGroup = 'high';
      } else if (avgPostsPerDay >= 1.6) {
        // Top 50% 中频用户：1.6-3.5 posts/天（接近中位数）
        frequencyGroup = 'medium_high';
      } else if (avgPostsPerDay >= 0.8) {
        // 中低频用户：0.8-1.6 posts/天
        frequencyGroup = 'medium';
      } else if (avgPostsPerDay >= 0.3) {
        // 低频用户：0.3-0.8 posts/天
        frequencyGroup = 'low';
      } else {
        // 极低频用户：<0.3 posts/天
        frequencyGroup = 'very_low';
      }

      // 5. 根据分组确定固定的运行间隔（小时）
      // 简化逻辑：不再动态计算，直接映射
      const groupToHoursMap = {
        'very_high': 7,    // 7小时：每天约3.4次
        'high': 8,         // 8小时：每天约3次
        'medium_high': 10, // 10小时：每天约2.4次
        'medium': 12,      // 12小时：每天约2次
        'low': 18,         // 18小时：每天约1.3次
        'very_low': 24     // 24小时：每天1次
      };

      const nextRunHours = groupToHoursMap[frequencyGroup] || 12;

      // 6. 计算下次运行时间（北京时间 8-24点）
      const nextRunTime = this.calculateNextRunTime(nextRunHours);

      // 7. 更新数据库
      await connection.query(
        `UPDATE scrape_tasks
         SET frequency_group = ?,
             avg_posts_per_day = ?,
             last_post_count = ?,
             next_run_time = ?
         WHERE id = ?`,
        [frequencyGroup, avgPostsPerDay, totalPostCount, nextRunTime, taskId]
      );

      console.log(
        `📊 频率更新: ${frequencyGroup} ` +
        `(${avgPostsPerDay.toFixed(2)} posts/天, 间隔 ${nextRunHours}h, 下次: ${nextRunTime})`
      );

    } finally {
      connection.release();
    }
  }

  /**
   * 计算下次运行时间（限制在北京时间 8-24点）
   * @param {number} hours - 间隔小时数
   * @returns {string} MySQL DATETIME 格式
   */
  calculateNextRunTime(hours) {
    const now = new Date();

    // 转换为北京时间 (UTC+8)
    const bjNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);

    // 添加间隔小时
    let nextRun = new Date(bjNow.getTime() + hours * 60 * 60 * 1000);

    // 获取北京时间的小时
    const bjHour = nextRun.getUTCHours();

    // 如果不在 8-24 点之间，调整到第二天早上 8 点
    if (bjHour < 8) {
      // 设置为当天 8 点
      nextRun.setUTCHours(8, 0, 0, 0);
    } else if (bjHour >= 24) {
      // 设置为第二天 8 点
      nextRun.setUTCDate(nextRun.getUTCDate() + 1);
      nextRun.setUTCHours(8, 0, 0, 0);
    }

    // 转换回 UTC 时间
    const utcNextRun = new Date(nextRun.getTime() - 8 * 60 * 60 * 1000);

    // 返回 MySQL DATETIME 格式
    return utcNextRun.toISOString().slice(0, 19).replace('T', ' ');
  }

  /**
   * 初始化用户频率分组（为现有任务设置默认值）
   */
  async initializeFrequencyGroups() {
    const connection = await this.getConnection();

    try {
      // 将所有 frequency_group 为 NULL 的任务设置为 'medium'
      const [result] = await connection.query(
        `UPDATE scrape_tasks
         SET frequency_group = 'medium',
             next_run_time = NOW()
         WHERE frequency_group IS NULL`
      );

      console.log(`✅ 初始化了 ${result.affectedRows} 个任务的频率分组`);

    } finally {
      connection.release();
    }
  }
}

