# -*- coding: utf-8 -*-
"""
==============================================================================
機器學習後台 REST API 伺服器 (Flask ML Server)
------------------------------------------------------------------------------
提供 Web 後台透過 HTTP API 進行：
1. 查詢最新 ML 模型評估指標與預測結果 (GET /api/predict)
2. 觸發 Python 機器學習模型重新訓練與特徵更新 (POST /api/retrain)
3. 單一使用者行為特徵即時推論 (POST /api/predict-single)
==============================================================================
"""

import os
import json
from flask import Flask, jsonify, request
from flask_cors import CORS
from ml_retention_model import train_and_evaluate

app = Flask(__name__)
CORS(app) # 允許跨網域存取 (CORS)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

@app.route('/', methods=['GET'])
def index():
    return jsonify({
        "status": "success",
        "message": "智慧選課機器學習 API 服務運作中！",
        "endpoints": {
            "get_predictions": "GET /api/predict",
            "trigger_retrain": "POST /api/retrain",
            "predict_single": "POST /api/predict-single"
        }
    })

@app.route('/api/predict', methods=['GET'])
def get_predictions():
    """取得最新 ML 評估數據與預測結果"""
    json_path = os.path.join(BASE_DIR, 'ml_predictions.json')
    if not os.path.exists(json_path):
        # 若不存在則自動觸發訓練
        train_and_evaluate()
        
    with open(json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    return jsonify(data)

@app.route('/api/retrain', methods=['POST'])
def trigger_retrain():
    """管理者在後台點擊按鈕，觸發 Python 機器學習重新訓練"""
    try:
        train_and_evaluate()
        return jsonify({
            "status": "success",
            "message": "機器學習模型 (Logistic Regression, Random Forest, XGBoost) 已成功完成重新訓練與更新！"
        })
    except Exception as e:
        return jsonify({
            "status": "error",
            "message": f"重新訓練失敗: {str(e)}"
        }), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    print(f"🚀 ML API 伺服器啟動中，監聽 Port: {port}...")
    app.run(host='0.0.0.0', port=port, debug=True)
