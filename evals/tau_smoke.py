"""Actual upstream Env/tools/reward, with a small custom task and scripted user."""
import os
os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")
from unittest.mock import patch
from tau_bench.envs.base import Env
from tau_bench.envs.retail.tools.get_order_details import GetOrderDetails
from tau_bench.envs.retail.tools.return_delivered_order_items import ReturnDeliveredOrderItems
from tau_bench.types import Action, Task

class ScriptedUser:
    def __init__(self):
        self.turn = 0
    def reset(self, instruction=None):
        self.turn = 0
        return "请查询订单 #W1000000 并帮我退商品 1001，原支付方式 credit_card_100。先查询并请我确认，再创建退货申请。"
    def step(self, content):
        self.turn += 1
        return "确认退该商品，退款原路退回，请提交。" if self.turn == 1 else "###STOP###"
    def get_total_cost(self):
        return 0.0

def make_smoke_env():
    def load_data():
        return {"orders": {"#W1000000": {"order_id": "#W1000000", "user_id": "alice", "status": "delivered", "items": [{"item_id": "1001", "name": "T-shirt", "price": 99}], "payment_history": [{"payment_method_id": "credit_card_100"}]}},
                "users": {"alice": {"payment_methods": {"credit_card_100": {"source": "credit_card"}}}}, "products": {}}
    task = Task(user_id="alice", instruction="Return item 1001 from order #W1000000 after confirmation", actions=[Action(name="return_delivered_order_items", kwargs={"order_id": "#W1000000", "item_ids": ["1001"], "payment_method_id": "credit_card_100"})], outputs=[])
    with patch("tau_bench.envs.base.load_user", return_value=ScriptedUser()):
        return Env(data_load_func=load_data, tools=[GetOrderDetails, ReturnDeliveredOrderItems], tasks=[task], wiki="你是售后助手。先查询订单并说明具体商品及退款方式，用户明确确认后才调用退货工具。工具返回的事实为准，申请成功不表示退款到账。回复简洁。", rules=[], user_strategy="human", user_model="unused", task_index=0)
