/**
 * 增量数据收集器 - 基于数据库的ID去重实现增量采集
 * 不再使用文件系统存储历史记录
 */
export class IncrementalCollector {
  constructor(config, database = null) {
    this.config = config;
    this.database = database;  // DatabaseManager 实例
  }

  /**
   * 获取数据项的唯一ID
   */
  getItemId(item) {
    return item.ID || item.id || item.tweet_id || item.status_id || item['User ID'];
  }

  /**
   * 处理推文/回复数据 (posts/replies)
   */
  async processPostsData(username, type, rawData) {
    if (!rawData || rawData.length === 0) {
      return { total: 0, new: 0, updated: 0, data: [] };
    }

    // 过滤掉没有ID的数据（无效数据）
    const validData = rawData.filter(item => this.getItemId(item));

    if (validData.length === 0) {
      console.error('    ❌ 所有数据无效（缺少ID）');
      return { total: 0, new: 0, updated: 0, data: [] };
    }

    // 上下文解析：如果是 replies 类型，根据行顺序推断回复关系
    // 规则：Reply 类型行的上一行是其父推文
    if (type === 'replies') {
      let previousTweetId = null;
      let conversationRootId = null;

      for (const row of validData) {
        const currentId = this.getItemId(row);
        const postType = row.Type;

        if (postType === 'Reply') {
          // 核心逻辑：当前 Reply 回复的是上一行的推文
          row.in_reply_to_tweet_id = previousTweetId;

          // 尝试继承对话根ID
          if (conversationRootId) {
            row.conversation_id = conversationRootId;
          } else if (previousTweetId) {
            // 如果没有根ID，且上一条存在，暂且认为上一条可能是根（简化逻辑）
            row.conversation_id = previousTweetId;
          }
        } else {
          // 如果不是 Reply，它可能是新对话的开始
          conversationRootId = currentId;
          row.conversation_id = currentId;
          row.in_reply_to_tweet_id = null;
        }

        // 更新指针
        previousTweetId = currentId;
      }
    }

    // 如果没有数据库,返回原始数据
    if (!this.database) {
      return {
        total: validData.length,
        new: validData.length,
        updated: 0,
        data: validData
      };
    }

    try {
      // 1. 确保用户存在,获取用户ID
      let userId = await this.database.getUserIdByUsername(username);

      if (!userId && validData.length > 0) {
        // 从第一条推文创建用户
        const firstPost = validData[0];
        const userData = {
          username: firstPost['Author Username'] || username,
          name: firstPost['Author Name'],
          user_id: null  // Posts CSV通常不包含User ID
        };
        userId = await this.database.upsertUser(userData);
      }

      // 2. 获取数据库中已有的推文ID
      const existingIds = await this.database.getCollectedPostIds(userId);

      // 3. 统计新数据和更新数据
      let newCount = 0;
      let updateCount = 0;

      validData.forEach(item => {
        const id = this.getItemId(item);
        if (id && existingIds.has(String(id))) {
          updateCount++;
        } else if (id) {
          newCount++;
        }
      });

      // 4. 批量插入或更新到数据库
      await this.database.batchUpsertPosts(validData, userId);

      // 5. 返回统计信息
      return {
        total: validData.length,
        new: newCount,
        updated: updateCount,
        data: validData
      };

    } catch (error) {
      console.error(`❌ 处理推文数据失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 处理关注关系数据 (followers/following)
   */
  async processFollowersData(username, type, rawData) {
    if (!rawData || rawData.length === 0) {
      return { total: 0, new: 0, updated: 0, data: [] };
    }

    // 如果没有数据库,返回原始数据
    if (!this.database) {
      return {
        total: rawData.length,
        new: rawData.length,
        updated: 0,
        data: rawData
      };
    }

    try {
      // 1. 确保目标用户存在
      let userId = await this.database.getUserIdByUsername(username);

      if (!userId) {
        const userData = { username };
        userId = await this.database.upsertUser(userData);
      }

      // V2 逻辑：Following 数据使用新表 twitter_followings
      if (type === 'following') {
        // 批量 Upsert 被关注的用户信息
        const idMap = await this.database.batchUpsertUsers(rawData);

        // 获取目标用户的内部 ID 列表
        const targetInternalIds = [];
        rawData.forEach(item => {
          const twitterId = item['User ID'] || item.user_id;
          if (twitterId && idMap[twitterId]) {
            targetInternalIds.push(idMap[twitterId]);
          }
        });

        // 批量插入关注关系
        const importedCount = await this.database.batchInsertFollowings(userId, targetInternalIds);

        return {
          total: rawData.length,
          new: importedCount,
          updated: 0,
          data: rawData
        };
      }

      // 旧版逻辑 (Followers 仍使用旧表，或者如果需要兼容)
      const relationType = type === 'followers' ? 'follower' : 'following';

      // 获取数据库中已有的关注关系ID
      const existingIds = await this.database.getCollectedFollowerIds(userId, relationType);

      // 统计新数据和更新数据
      let newCount = 0;
      let updateCount = 0;

      rawData.forEach(item => {
        const id = item['User ID'] || item.user_id;
        if (id && existingIds.has(String(id))) {
          updateCount++;
        } else if (id) {
          newCount++;
        }
      });

      // 批量插入或更新到数据库
      await this.database.batchUpsertFollowers(rawData, userId, relationType);

      return {
        total: rawData.length,
        new: newCount,
        updated: updateCount,
        data: rawData
      };

    } catch (error) {
      console.error(`❌ 处理关注数据失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 统一入口 - 处理采集结果
   */
  async processCollectedData(username, type, rawData) {
    // 根据类型调用不同的处理方法
    if (type === 'posts' || type === 'replies' || type === 'tweets') {
      return await this.processPostsData(username, type, rawData);
    } else if (type === 'followers' || type === 'following') {
      return await this.processFollowersData(username, type, rawData);
    } else {
      console.warn(`⚠️  未知的数据类型: ${type}`);
      return {
        total: rawData.length,
        new: rawData.length,
        updated: 0,
        data: rawData
      };
    }
  }

  /**
   * 获取用户采集统计 (从数据库)
   */
  async getStats(username, type) {
    if (!this.database) {
      return {
        username,
        type,
        totalCollected: 0,
        lastRun: null
      };
    }

    try {
      const userId = await this.database.getUserIdByUsername(username);
      if (!userId) {
        return {
          username,
          type,
          totalCollected: 0,
          lastRun: null
        };
      }

      // 根据类型查询不同的表
      if (type === 'posts' || type === 'replies' || type === 'tweets') {
        const ids = await this.database.getCollectedPostIds(userId);
        return {
          username,
          type,
          totalCollected: ids.size,
          lastRun: new Date().toISOString()
        };
      } else if (type === 'followers' || type === 'following') {
        const relationType = type === 'followers' ? 'follower' : 'following';
        const ids = await this.database.getCollectedFollowerIds(userId, relationType);
        return {
          username,
          type,
          totalCollected: ids.size,
          lastRun: new Date().toISOString()
        };
      }

      return {
        username,
        type,
        totalCollected: 0,
        lastRun: null
      };

    } catch (error) {
      console.error(`获取统计失败: ${error.message}`);
      return {
        username,
        type,
        totalCollected: 0,
        lastRun: null
      };
    }
  }
}

export default IncrementalCollector;
