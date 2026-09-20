# -*- coding: utf-8 -*-
"""
==============================================================================
機器學習使用者回訪機率預測系統 (User Revisit / Retention Prediction System)
------------------------------------------------------------------------------
本腳本負責：
1. 數據取得與特徵工程 (Data Acquisition & Feature Engineering)
2. 資料集切分 (Train/Test Split: 80/20)
3. Python 機器學習建模 (Logistic Regression, Random Forest, XGBoost)
4. 模型效能評估 (Accuracy, Precision, Recall, F1-Score, ROC-AUC)
5. 模型特徵重要性與可解釋性分析 (Feature Importance & Coefficient Analysis)
6. 視覺化圖表繪製與 JSON 預測結果導出 (供前端 Web 後台儀表板載入)
==============================================================================
"""

import os
import sys
import json
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns

# 設定系統標準輸出編碼
if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import RandomForestClassifier
from xgboost import XGBClassifier
from sklearn.metrics import (
    accuracy_score, precision_score, recall_score, f1_score,
    roc_auc_score, roc_curve, confusion_matrix
)

# 設定 中文字型與繪圖樣式
plt.rcParams['font.sans-serif'] = ['Microsoft JhengHei', 'SimHei', 'Arial', 'sans-serif']
plt.rcParams['axes.unicode_minus'] = False
sns.set_theme(style="whitegrid", font="Microsoft JhengHei")

# 定義特徵中文名稱映射表
FEATURE_NAMES_ZH = {
    'total_logins': '總登入/操作次數',
    'active_days': '歷史活躍天數',
    'recency_days': '距最近登入位移天數',
    'select_course_count': '成功選課次數',
    'cancel_course_count': '取消選課變更次數',
    'action_diversity': '操作動作種類多樣性',
    'peak_hour_ratio': '熱門尖峰時段操作比例',
    'grade_level': '使用者所屬年級 (1-6年級)',
    'avg_interval_hours': '平均操作間隔小時數'
}

def generate_synthetic_user_logs(num_users=320, random_state=42):
    """
    根據實際系統的使用者結構 (班級 101~605 等) 產生擬真 Web 網站行為操作 Log 數據。
    確保資料集具備足夠的特徵分佈與實際統計特性。
    """
    np.random.seed(random_state)
    
    users = []
    # 產生一到六年級班級 (例如 101-105, 201-205, ... 601-605)
    for grade in range(1, 7):
        for cls in range(1, 6):
            class_code = f"{grade}0{cls}"
            # 每個班級可有多個學生或導師帳號紀錄
            users.append({'user_id': class_code, 'grade': grade})
    
    # 擴充班級帳號至指定數量 num_users
    extended_users = []
    for i in range(num_users):
        base = users[i % len(users)]
        extended_users.append({
            'user_id': f"{base['user_id']}" if i < len(users) else f"{base['user_id']}_sub{i//len(users)}",
            'grade': base['grade']
        })
        
    data = []
    for u in extended_users:
        grade = u['grade']
        
        # 低留存/高離群行為 or 高留存行為特徵生成
        user_type = np.random.choice(['high_active', 'medium_active', 'low_churn'], p=[0.45, 0.35, 0.20])
        
        if user_type == 'high_active':
            total_logins = np.random.randint(15, 60)
            active_days = np.random.randint(5, 25)
            recency_days = np.random.uniform(0.1, 3.0) # 剛登入不久
            select_course_count = np.random.randint(1, 4)
            cancel_course_count = np.random.randint(0, 3)
            action_diversity = np.random.randint(3, 7)
            peak_hour_ratio = np.random.uniform(0.4, 0.9)
            avg_interval_hours = np.random.uniform(2.0, 18.0)
            # 高活躍使用者有 88% 機率回訪
            is_returned = 1 if np.random.rand() < 0.88 else 0
            
        elif user_type == 'medium_active':
            total_logins = np.random.randint(5, 18)
            active_days = np.random.randint(2, 8)
            recency_days = np.random.uniform(2.0, 7.0)
            select_course_count = np.random.randint(0, 2)
            cancel_course_count = np.random.randint(0, 2)
            action_diversity = np.random.randint(2, 5)
            peak_hour_ratio = np.random.uniform(0.2, 0.6)
            avg_interval_hours = np.random.uniform(12.0, 36.0)
            # 中度活躍使用者有 55% 機率回訪
            is_returned = 1 if np.random.rand() < 0.55 else 0
            
        else: # low_churn
            total_logins = np.random.randint(1, 6)
            active_days = np.random.randint(1, 3)
            recency_days = np.random.uniform(7.0, 21.0) # 久未登入
            select_course_count = np.random.randint(0, 1)
            cancel_course_count = np.random.randint(0, 1)
            action_diversity = np.random.randint(1, 3)
            peak_hour_ratio = np.random.uniform(0.0, 0.3)
            avg_interval_hours = np.random.uniform(36.0, 120.0)
            # 低活躍使用者僅有 12% 機率回訪
            is_returned = 1 if np.random.rand() < 0.12 else 0

        data.append({
            'user_id': u['user_id'],
            'grade_level': grade,
            'total_logins': total_logins,
            'active_days': active_days,
            'recency_days': round(recency_days, 1),
            'select_course_count': select_course_count,
            'cancel_course_count': cancel_course_count,
            'action_diversity': action_diversity,
            'peak_hour_ratio': round(peak_hour_ratio, 2),
            'avg_interval_hours': round(avg_interval_hours, 1),
            'is_returned': is_returned
        })

    df = pd.DataFrame(data)
    return df

def train_and_evaluate():
    """
    主要機器學習 Pipeline：特徵工程 -> 資料分割 -> 建模 -> 比較評估 -> 圖表與 JSON 導出
    """
    print("[1/5] 讀取並構建網站行為 Log 特徵資料集...")
    df = generate_synthetic_user_logs(num_users=350, random_state=42)
    
    # 定義特徵欄位與目標欄位
    feature_cols = [
        'total_logins', 'active_days', 'recency_days',
        'select_course_count', 'cancel_course_count',
        'action_diversity', 'peak_hour_ratio', 'grade_level',
        'avg_interval_hours'
    ]
    target_col = 'is_returned'
    
    X = df[feature_cols]
    y = df[target_col]
    
    print(f"資料筆數: {len(df)} 筆, 特徵數量: {len(feature_cols)}, 正樣本 (回訪) 比例: {y.mean():.2%}")
    
    print("[2/5] 切分訓練集與測試集 (80/20 分配，分層抽樣)...")
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )
    
    # 特徵標準化 (用於 Logistic Regression)
    scaler = StandardScaler()
    X_train_scaled = scaler.fit_transform(X_train)
    X_test_scaled = scaler.transform(X_test)
    
    print("[3/5] 訓練機器學習模型 (Logistic Regression, Random Forest, XGBoost)...")
    models = {
        'Logistic Regression': LogisticRegression(random_state=42, max_iter=1000),
        'Random Forest': RandomForestClassifier(n_estimators=120, max_depth=6, random_state=42),
        'XGBoost': XGBClassifier(n_estimators=100, max_depth=4, learning_rate=0.08, random_state=42, eval_metric='logloss')
    }
    
    metrics_summary = []
    trained_models = {}
    predictions_dict = {}
    roc_data = {}
    confusion_matrices = {}
    
    # 對全量資料進行機率推論供儀表板呈現
    X_all_scaled = scaler.transform(X)
    df_results = df.copy()
    
    for name, model in models.items():
        if name == 'Logistic Regression':
            model.fit(X_train_scaled, y_train)
            y_pred = model.predict(X_test_scaled)
            y_proba = model.predict_proba(X_test_scaled)[:, 1]
            all_proba = model.predict_proba(X_all_scaled)[:, 1]
        else:
            model.fit(X_train, y_train)
            y_pred = model.predict(X_test)
            y_proba = model.predict_proba(X_test)[:, 1]
            all_proba = model.predict_proba(X)[:, 1]
            
        trained_models[name] = model
        df_results[f'{name}_proba'] = np.round(all_proba * 100, 1)
        
        # 計算各項評估指標
        acc = accuracy_score(y_test, y_pred)
        prec = precision_score(y_test, y_pred)
        rec = recall_score(y_test, y_pred)
        f1 = f1_score(y_test, y_pred)
        auc = roc_auc_score(y_test, y_proba)
        cm = confusion_matrix(y_test, y_pred).tolist()
        
        fpr, tpr, _ = roc_curve(y_test, y_proba)
        roc_data[name] = {'fpr': fpr.tolist(), 'tpr': tpr.tolist(), 'auc': float(auc)}
        confusion_matrices[name] = cm
        
        metrics_summary.append({
            'model': name,
            'accuracy': float(acc),
            'precision': float(prec),
            'recall': float(rec),
            'f1_score': float(f1),
            'roc_auc': float(auc),
            'confusion_matrix': cm
        })
        print(f"  - {name:20s} | Accuracy: {acc:.4f} | Precision: {prec:.4f} | Recall: {rec:.4f} | F1: {f1:.4f} | ROC-AUC: {auc:.4f}")

    # 特徵重要性分析 (Feature Importance / Coefficients)
    print("[4/5] 分析特徵重要性與模型可解釋性 (Feature Importance)...")
    lr_coefs = trained_models['Logistic Regression'].coef_[0]
    rf_importances = trained_models['Random Forest'].feature_importances_
    xgb_importances = trained_models['XGBoost'].feature_importances_
    
    feature_importance_list = []
    for idx, col in enumerate(feature_cols):
        feature_importance_list.append({
            'feature': col,
            'feature_name_zh': FEATURE_NAMES_ZH.get(col, col),
            'lr_coef': float(lr_coefs[idx]),
            'rf_importance': float(rf_importances[idx]),
            'xgb_importance': float(xgb_importances[idx]),
            'avg_importance': float((rf_importances[idx] + xgb_importances[idx]) / 2)
        })
    
    # 依據平均重要性排序
    feature_importance_list.sort(key=lambda x: x['avg_importance'], reverse=True)

    # 計算綜合平均回訪機率與風險等級
    df_results['avg_return_prob'] = np.round(
        (df_results['Logistic Regression_proba'] + df_results['Random Forest_proba'] + df_results['XGBoost_proba']) / 3.0, 1
    )
    
    def get_risk_level(prob):
        if prob >= 70.0:
            return {'level': 'Low Risk', 'label_zh': '高回訪機率 (低流失風險)', 'badge': 'risk-low'}
        elif prob >= 40.0:
            return {'level': 'Medium Risk', 'label_zh': '中回訪機率 (中等關注)', 'badge': 'risk-med'}
        else:
            return {'level': 'High Risk', 'label_zh': '低回訪機率 (高流失警訊)', 'badge': 'risk-high'}
            
    user_predictions = []
    for _, row in df_results.iterrows():
        risk_info = get_risk_level(row['avg_return_prob'])
        
        # 找出影響該使用者的關鍵特徵提示
        top_reasons = []
        if row['recency_days'] > 5.0:
            top_reasons.append(f"距上次登入隔 {row['recency_days']} 天 (偏久)")
        if row['total_logins'] >= 15:
            top_reasons.append(f"累積登入 {row['total_logins']} 次 (高活躍)")
        if row['select_course_count'] > 0:
            top_reasons.append(f"已成功選課 {row['select_course_count']} 次")
        if row['avg_interval_hours'] > 48.0:
            top_reasons.append(f"平均操作間隔 {row['avg_interval_hours']} 小時")
        if not top_reasons:
            top_reasons.append("登入頻率與動作類型一般")

        user_predictions.append({
            'user_id': str(row['user_id']),
            'grade_level': int(row['grade_level']),
            'total_logins': int(row['total_logins']),
            'active_days': int(row['active_days']),
            'recency_days': float(row['recency_days']),
            'select_course_count': int(row['select_course_count']),
            'cancel_course_count': int(row['cancel_course_count']),
            'action_diversity': int(row['action_diversity']),
            'lr_prob': round(float(row['Logistic Regression_proba']), 1),
            'rf_prob': round(float(row['Random Forest_proba']), 1),
            'xgb_prob': round(float(row['XGBoost_proba']), 1),
            'avg_return_prob': round(float(row['avg_return_prob']), 1),
            'predicted_label': int(1 if row['avg_return_prob'] >= 50.0 else 0),
            'risk_level': risk_info['level'],
            'risk_label_zh': risk_info['label_zh'],
            'risk_badge': risk_info['badge'],
            'top_reasons': top_reasons[:2]
        })

    # [5/5] 繪製高質感視覺化圖表與導出 JSON 數據
    print("[5/5] 輸出評估圖表與前端 JSON 數據檔...")
    output_dir = os.path.dirname(os.path.abspath(__file__))
    
    # 1. 導出 JSON 數據供 Web 前端載入
    export_payload = {
        'summary': {
            'best_model': max(metrics_summary, key=lambda x: x['f1_score'])['model'],
            'total_users_evaluated': len(user_predictions),
            'avg_return_rate_pct': float(np.round(np.mean([u['avg_return_prob'] for u in user_predictions]), 1)),
            'high_risk_count': sum(1 for u in user_predictions if u['risk_level'] == 'High Risk'),
            'med_risk_count': sum(1 for u in user_predictions if u['risk_level'] == 'Medium Risk'),
            'low_risk_count': sum(1 for u in user_predictions if u['risk_level'] == 'Low Risk'),
            'best_f1_score': float(max(x['f1_score'] for x in metrics_summary)),
            'scaler_mean': scaler.mean_.tolist(),
            'scaler_scale': scaler.scale_.tolist(),
            'feature_cols': feature_cols
        },
        'metrics': metrics_summary,
        'feature_importance': feature_importance_list,
        'roc_curves': roc_data,
        'user_predictions': user_predictions
    }
    
    json_path = os.path.join(output_dir, 'ml_predictions.json')
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(export_payload, f, ensure_ascii=False, indent=2)
    print(f"  [OK] 成功匯出 JSON 數據至 {json_path}")

    js_path = os.path.join(output_dir, 'ml_predictions.js')
    with open(js_path, 'w', encoding='utf-8') as f:
        f.write('window.ML_PREDICTIONS_DATA = ' + json.dumps(export_payload, ensure_ascii=False, indent=2) + ';\n')
    print(f"  [OK] 成功匯出 JS 數據載入檔至 {js_path}")

    # 繪製圖表 1: 三大模型五項效能指標比較圖
    fig, ax = plt.subplots(figsize=(10, 5.5))
    metrics_df = pd.DataFrame(metrics_summary).melt(
        id_vars=['model'], 
        value_vars=['accuracy', 'precision', 'recall', 'f1_score', 'roc_auc'],
        var_name='metric', value_name='score'
    )
    metric_map = {'accuracy': 'Accuracy', 'precision': 'Precision', 'recall': 'Recall', 'f1_score': 'F1-Score', 'roc_auc': 'ROC-AUC'}
    metrics_df['metric'] = metrics_df['metric'].map(metric_map)
    
    palette = {'Logistic Regression': '#4c72b0', 'Random Forest': '#55a868', 'XGBoost': '#c44e52'}
    sns.barplot(data=metrics_df, x='metric', y='score', hue='model', palette=palette, ax=ax)
    
    ax.set_ylim(0.5, 1.05)
    ax.set_title("三大機器學習模型評估指標比較 (Logistic Regression vs RF vs XGBoost)", fontsize=14, fontweight='bold', pad=12)
    ax.set_xlabel("評估指標 (Evaluation Metrics)", fontsize=11, fontweight='bold')
    ax.set_ylabel("分數 (Score)", fontsize=11, fontweight='bold')
    ax.legend(title="模型 (Models)", loc='lower right', frameon=True)
    
    for p in ax.patches:
        height = p.get_height()
        if height > 0:
            ax.annotate(f"{height:.3f}", (p.get_x() + p.get_width() / 2., height),
                        ha='center', va='bottom', fontsize=8, xytext=(0, 3), textcoords='offset points')
    
    plt.tight_layout()
    chart1_path = os.path.join(output_dir, 'ml_model_comparison.png')
    plt.savefig(chart1_path, dpi=300)
    plt.close()

    # 繪製圖表 2: ROC Curves
    fig, ax = plt.subplots(figsize=(8, 6))
    colors = {'Logistic Regression': '#4c72b0', 'Random Forest': '#55a868', 'XGBoost': '#c44e52'}
    
    for name, data in roc_data.items():
        ax.plot(data['fpr'], data['tpr'], label=f"{name} (AUC = {data['auc']:.3f})", color=colors[name], linewidth=2.2)
        
    ax.plot([0, 1], [0, 1], 'k--', label='Chance / Random Guess', linewidth=1.2)
    ax.set_xlim([0.0, 1.0])
    ax.set_ylim([0.0, 1.05])
    ax.set_xlabel("False Positive Rate (假陽性率)", fontsize=11, fontweight='bold')
    ax.set_ylabel("True Positive Rate (真陽性率 / Recall)", fontsize=11, fontweight='bold')
    ax.set_title("受試者工作特徵曲線 (ROC Curves Comparison)", fontsize=14, fontweight='bold', pad=12)
    ax.legend(loc="lower right", frameon=True)
    plt.tight_layout()
    chart2_path = os.path.join(output_dir, 'ml_roc_curves.png')
    plt.savefig(chart2_path, dpi=300)
    plt.close()

    # 繪製圖表 3: 特徵重要性排名 (Random Forest vs XGBoost)
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(14, 5.5))
    
    feat_df = pd.DataFrame(feature_importance_list)
    feat_df_rf = feat_df.sort_values(by='rf_importance', ascending=True)
    feat_df_xgb = feat_df.sort_values(by='xgb_importance', ascending=True)
    
    ax1.barh(feat_df_rf['feature_name_zh'], feat_df_rf['rf_importance'], color='#55a868')
    ax1.set_title("Random Forest 特徵重要性 (Gini Importance)", fontsize=12, fontweight='bold')
    ax1.set_xlabel("Importance", fontsize=10)
    
    ax2.barh(feat_df_xgb['feature_name_zh'], feat_df_xgb['xgb_importance'], color='#c44e52')
    ax2.set_title("XGBoost 特徵重要性 (Gain Importance)", fontsize=12, fontweight='bold')
    ax2.set_xlabel("Importance", fontsize=10)
    
    plt.suptitle("網站行為預測特徵關鍵因子排名比較", fontsize=14, fontweight='bold', y=1.02)
    plt.tight_layout()
    chart3_path = os.path.join(output_dir, 'ml_feature_importance.png')
    plt.savefig(chart3_path, dpi=300)
    plt.close()

    print(f"  [OK] 成功輸出三張高解析度評估圖表至 {output_dir}")
    print("\n==============================================================================")
    print("機器學習訓練與評估完成！可開啟網頁後台體驗回訪預測 dashboard。")
    print("==============================================================================")

if __name__ == '__main__':
    train_and_evaluate()
