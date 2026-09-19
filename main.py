import os
import random
from datetime import datetime, timezone
import discord
from discord.ext import commands
from discord import app_commands
from supabase import create_client, Client
from dotenv import load_dotenv

# 1. 加载环境变量 (Render 会在后台直接提供，本地测试用 .env 文件)
load_dotenv()
TOKEN = os.getenv('DISCORD_TOKEN')
SUPABASE_URL = os.getenv('SUPABASE_URL')
SUPABASE_KEY = os.getenv('SUPABASE_KEY')

# 2. 初始化 Supabase 客户端和 Discord Bot
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

class MeowBot(commands.Bot):
    def __init__(self):
        super().__init__(command_prefix="!", intents=discord.Intents.default())

    async def setup_hook(self):
        # 启动时同步全局斜杠指令
        await self.tree.sync()
        print("Bot is ready and commands are synced.")

bot = MeowBot()

# 3. /meow 指令：设置 1 次 / 300 秒 (5分钟) 的冷却
@bot.tree.command(name="meow", description="meow and get a meow point")
@app_commands.checks.cooldown(1, 300.0, key=lambda i: (i.guild_id, i.user.id))
async def meow(interaction: discord.Interaction):
    user_id = str(interaction.user.id)
    guild_id = str(interaction.guild_id)
    
    # 计算 1% 概率彩蛋
    reply_text = ":3" if random.randint(1, 100) == 1 else "meow"
    
    # 获取当前月份 (UTC)
    month_str = datetime.now(timezone.utc).strftime("%Y-%m")
    
    # 4. 数据库更新逻辑
    try:
        # 检查本月是否已有记录
        response = supabase.table("meow_records").select("*") \
            .eq("user_id", user_id).eq("guild_id", guild_id).eq("record_month", month_str).execute()
        
        if len(response.data) > 0:
            # 如果有，积分 +1 并更新
            current_count = response.data[0]['meows_count']
            record_id = response.data[0]['id']
            supabase.table("meow_records").update({"meows_count": current_count + 1}) \
                .eq("id", record_id).execute()
        else:
            # 如果没有，创建本月新记录
            supabase.table("meow_records").insert({
                "user_id": user_id,
                "guild_id": guild_id,
                "record_month": month_str,
                "meows_count": 1
            }).execute()
            
        await interaction.response.send_message(reply_text)
        
    except Exception as e:
        print(f"Database Error: {e}")
        await interaction.response.send_message("meow... (But database failed to update :c)", ephemeral=True)

# 5. 冷却触发时的错误处理
@bot.tree.error
async def on_app_command_error(interaction: discord.Interaction, error: app_commands.AppCommandError):
    if isinstance(error, app_commands.CommandOnCooldown):
        # 仅限触发者可见的提示 (ephemeral=True)
        await interaction.response.send_message(
            f"Meow on cooldown! Please try again in {error.retry_after:.1f} seconds.", 
            ephemeral=True
        )
    else:
        print(f"Unhandled error: {error}")

if __name__ == "__main__":
    bot.run(TOKEN)
