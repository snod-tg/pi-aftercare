"""Validate retail writes against tool facts already observed by the agent, never task answers."""
from collections import Counter
import json


class ObservedOrderGuard:
    def __init__(self):
        self.orders = {}
        self.products = {}

    def observe(self, name, observation):
        try:
            value = json.loads(observation)
        except (ValueError, TypeError):
            return
        if not isinstance(value, dict):
            return
        if name == 'get_product_details' and value.get('product_id') and isinstance(value.get('variants'), dict):
            self.products[value['product_id']] = value
        if name in ('get_order_details', 'return_delivered_order_items', 'exchange_delivered_order_items',
                    'modify_pending_order_items', 'modify_pending_order_address', 'cancel_pending_order'):
            if value.get('order_id') and isinstance(value.get('items'), list):
                self.orders[value['order_id']] = value

    def validate(self, action):
        allowed_status = {
            'return_delivered_order_items': 'delivered', 'exchange_delivered_order_items': 'delivered',
            'modify_pending_order_items': 'pending', 'modify_pending_order_address': 'pending',
            'cancel_pending_order': 'pending',
        }
        if action.name not in allowed_status:
            return None
        kwargs = action.kwargs
        order = self.orders.get(kwargs.get('order_id'))
        if order is None:
            return 'Read get_order_details for this exact order before writing; do not guess its contents.'
        if order.get('status') != allowed_status[action.name]:
            return f"Observed order status {order.get('status')} does not permit {action.name}; reread state and choose an allowed next action."
        if 'item_ids' not in kwargs:
            return None
        item_ids = kwargs['item_ids']
        if not isinstance(item_ids, list) or not item_ids or not all(isinstance(i, str) for i in item_ids):
            return 'item_ids must be a nonempty list of observed item IDs.'
        available = Counter(i['item_id'] for i in order['items'])
        if Counter(item_ids) - available:
            return 'Selected items or quantities do not belong to this order; separate orders and preserve unit counts.'
        if action.name not in ('exchange_delivered_order_items', 'modify_pending_order_items'):
            return None
        new_ids = kwargs.get('new_item_ids')
        if not isinstance(new_ids, list) or len(new_ids) != len(item_ids):
            return 'Pair each original unit with exactly one replacement unit.'
        by_id = {i['item_id']: i for i in order['items']}
        for old, new in zip(item_ids, new_ids):
            product = self.products.get(by_id[old].get('product_id'))
            if product is None:
                return 'Read get_product_details for the original product before choosing a replacement.'
            variant = product['variants'].get(new)
            if not variant or not variant.get('available'):
                return 'Replacement is not an observed available variant of the original product.'
        return None
