// 1. 初始化 Firebase 連線
const firebaseConfig = {
    apiKey: "AIzaSyDj0tyPXaNM2lMrxELUo2QPn-xec-sCB5I",
    authDomain: "jtps-library-course-system.firebaseapp.com",
    databaseURL: "https://jtps-library-course-system-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "jtps-library-course-system",
    storageBucket: "jtps-library-course-system.firebasestorage.app",
    messagingSenderId: "17056662142",
    appId: "1:17056662142:web:8a3c6eea2fe585b1c3ce2f"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore(); // 建立 db 物件供後續使用


const app = {
    mode: null, // 'user' | 'admin'
    currentUser: null,
    
	// 改為預設空值，從雲端下載
    selectedCourses: {},
    systemSettings: { openStartDate: "", openEndDate: "", openStartTime: "", openEndTime: "", adminPassword: "admin" },
    systemUsers: {},
    draftSelections: [],
    currentUserLogsData: [],
    currentTimeRangeLogsData: [],

    // 星期定義
    weekdays: [
        { id: 'mon', name: '星期一' },
        { id: 'tue', name: '星期二' },
        { id: 'wed', name: '星期三' },
        { id: 'thu', name: '星期四' },
        { id: 'fri', name: '星期五' }
    ],

// 2. 初始化：從雲端資料庫載入資料與啟動即時監聽
    async init() {
        try {
            // 從 Firebase Firestore 下載初次資料
            const [coursesDoc, settingsDoc, usersDoc] = await Promise.all([
                db.collection('system').doc('courses').get(),
                db.collection('system').doc('settings').get(),
                db.collection('system').doc('users').get()
            ]);
            
            if (coursesDoc.exists) this.selectedCourses = coursesDoc.data();
            if (settingsDoc.exists) this.systemSettings = settingsDoc.data();
            if (usersDoc.exists) this.systemUsers = usersDoc.data();
        } catch (error) {
            console.error("下載資料失敗，使用預設值:", error);
        }

        // 確保 systemSettings 有 adminPassword
        if (!this.systemSettings.adminPassword) {
            this.systemSettings.adminPassword = 'admin';
        }
        for (let key in this.selectedCourses) {
            if (!Array.isArray(this.selectedCourses[key])) {
                this.selectedCourses[key] = [];
            }
        }
        
        this.migrateToNumericClasses(); // 班級代碼轉移
        await this.saveState();        // 將轉移後的資料存回雲端
        this.updateAnnouncement();

        // 啟動多使用者即時同步監聽
        this.setupListeners();

        // 嘗試還原登入狀態 (F5 重新整理保持登入)
        this.restoreSession();

        if (!this.mode) {
            this.renderSchedule();
        }
    },

    // 啟動 Firebase Firestore 即時同步監聽
    setupListeners() {
        // 1. 監聽選課資料
        db.collection('system').doc('courses').onSnapshot((doc) => {
            if (doc.exists) {
                this.selectedCourses = doc.data() || {};
                for (let key in this.selectedCourses) {
                    if (!Array.isArray(this.selectedCourses[key])) {
                        this.selectedCourses[key] = [];
                    }
                }
                if (this.mode) {
                    this.renderSchedule();
                    if (this.mode === 'admin') {
                        this.renderLoginStatusList();
                    }
                }
            }
        }, (error) => {
            console.error("即時監聽選課資料失敗:", error);
        });

        // 2. 監聽系統設定
        db.collection('system').doc('settings').onSnapshot((doc) => {
            if (doc.exists) {
                this.systemSettings = doc.data() || {};
                if (!this.systemSettings.adminPassword) {
                    this.systemSettings.adminPassword = 'admin';
                }
                this.updateAnnouncement();
                if (this.mode === 'user') {
                    this.updateUserOpenStatusUI();
                    this.renderSchedule();
                } else if (this.mode === 'admin') {
                    const startInput = document.getElementById('admin-start-date');
                    const startTimeInput = document.getElementById('admin-start-time');
                    const endInput = document.getElementById('admin-end-date');
                    const endTimeInput = document.getElementById('admin-end-time');
                    if (startInput && endInput && document.activeElement !== startInput && document.activeElement !== endInput && document.activeElement !== startTimeInput && document.activeElement !== endTimeInput) {
                        startInput.value = this.systemSettings.openStartDate || '';
                        if (startTimeInput) startTimeInput.value = this.systemSettings.openStartTime || '08:00';
                        endInput.value = this.systemSettings.openEndDate || '';
                        if (endTimeInput) endTimeInput.value = this.systemSettings.openEndTime || '17:00';
                    }
                }
            }
        }, (error) => {
            console.error("即時監聽系統設定失敗:", error);
        });

        // 3. 監聽使用者名單
        db.collection('system').doc('users').onSnapshot((doc) => {
            if (doc.exists) {
                this.systemUsers = doc.data() || {};

                // 若當前登入之一般使用者帳號被刪除，提醒並自動登出
                if (this.mode === 'user' && this.currentUser && !this.systemUsers[this.currentUser]) {
                    alert('您的帳號已被管理者刪除，系統將自動登出。');
                    this.logout();
                    return;
                }

                if (this.mode === 'admin') {
                    this.renderUserList();
                    this.renderLoginStatusList();
                }
            }
        }, (error) => {
            console.error("即時監聽使用者名單失敗:", error);
        });
    },

    // 恢復登入狀態 (F5 重新整理時讀取 localStorage)
    restoreSession() {
        try {
            const savedSession = localStorage.getItem('course_system_session');
            if (!savedSession) return;
            
            const session = JSON.parse(savedSession);
            if (session && session.mode && session.currentUser) {
                if (session.mode === 'user') {
                    if (this.systemUsers[session.currentUser]) {
                        this.currentUser = session.currentUser;
                        this.mode = 'user';
                        
                        // 初始化草稿：讀取此使用者已經確認過的課程
                        this.draftSelections = [];
                        for (const [courseId, users] of Object.entries(this.selectedCourses)) {
                            if (users.includes(this.currentUser)) {
                                this.draftSelections.push(courseId);
                            }
                        }

                        this.activateAppView('user');
                    } else {
                        // 帳號已不存在，清除無效 Session
                        localStorage.removeItem('course_system_session');
                    }
                } else if (session.mode === 'admin') {
                    this.currentUser = 'Admin';
                    this.mode = 'admin';
                    this.activateAppView('admin');
                }
            }
        } catch (error) {
            console.error("還原登入狀態失敗:", error);
            localStorage.removeItem('course_system_session');
        }
    },

    // 資料移轉輔助函式
    migrateToNumericClasses() {
        const chineseGradeMap = { '一': '1', '二': '2', '三': '3', '四': '4', '五': '5', '六': '6' };
        const chineseNumMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
        
        const convert = (name) => {
            if (/^[1-6][0-9]{2}$/.test(name)) return name;
            const match = name.match(/^([一二三四五六])年(.*)班$/);
            if (!match) return name;
            
            const grade = chineseGradeMap[match[1]];
            let classPart = match[2];
            let classNum = 0;
            
            if (!isNaN(parseInt(classPart))) {
                classNum = parseInt(classPart);
            } else {
                if (classPart === '十') classNum = 10;
                else if (classPart.length === 1) classNum = chineseNumMap[classPart] || 0;
                else if (classPart.startsWith('十')) classNum = 10 + (chineseNumMap[classPart[1]] || 0);
                else if (classPart.endsWith('十')) classNum = (chineseNumMap[classPart[0]] || 0) * 10;
            }
            
            if (!grade || classNum === 0) return name;
            return `${grade}${String(classNum).padStart(2, '0')}`;
        };

        let changed = false;
        const newUsers = {};
        for (const [name, data] of Object.entries(this.systemUsers)) {
            const newName = convert(name);
            newUsers[newName] = data;
            if (newName !== name) changed = true;
        }
        if (changed) this.systemUsers = newUsers;

        for (const courseId in this.selectedCourses) {
            this.selectedCourses[courseId] = this.selectedCourses[courseId].map(u => {
                const newU = convert(u);
                if (newU !== u) changed = true;
                return newU;
            });
        }
    },

  // 3. 儲存：將所有狀態同步到雲端資料庫
    async saveState() {
        try {
            await db.collection('system').doc('courses').set(this.selectedCourses);
            await db.collection('system').doc('settings').set(this.systemSettings);
            await db.collection('system').doc('users').set(this.systemUsers);
            console.log("雲端資料存檔成功！");
        } catch (error) {
            console.error("雲端存檔失敗:", error);
            alert("雲端儲存失敗，請檢查網路連線或 Firebase 權限！");
        }
    },

    updateAnnouncement() {
        const annDates = document.getElementById('announcement-dates');
        if (this.systemSettings.openStartDate && this.systemSettings.openEndDate) {
            const startTimeStr = this.systemSettings.openStartTime ? ` ${this.systemSettings.openStartTime}` : '';
            const endTimeStr = this.systemSettings.openEndTime ? ` ${this.systemSettings.openEndTime}` : '';
            annDates.textContent = `${this.systemSettings.openStartDate}${startTimeStr} ~ ${this.systemSettings.openEndDate}${endTimeStr}`;
        } else {
            annDates.textContent = '尚未設定';
        }
    },

    isSystemOpen() {
        if (!this.systemSettings || !this.systemSettings.openStartDate || !this.systemSettings.openEndDate) {
            return false;
        }

        try {
            const startClean = String(this.systemSettings.openStartDate).replace(/\//g, '-').trim();
            const endClean = String(this.systemSettings.openEndDate).replace(/\//g, '-').trim();

            const sParts = startClean.split('-').map(Number);
            const eParts = endClean.split('-').map(Number);

            if (sParts.length < 3 || eParts.length < 3 || sParts.some(isNaN) || eParts.some(isNaN)) {
                return false;
            }

            const startTime = (this.systemSettings.openStartTime || '00:00').trim();
            const endTime = (this.systemSettings.openEndTime || '23:59').trim();

            const sTimeParts = startTime.split(':').map(Number);
            const eTimeParts = endTime.split(':').map(Number);

            const sHour = isNaN(sTimeParts[0]) ? 0 : sTimeParts[0];
            const sMin = isNaN(sTimeParts[1]) ? 0 : sTimeParts[1];
            const eHour = isNaN(eTimeParts[0]) ? 23 : eTimeParts[0];
            const eMin = isNaN(eTimeParts[1]) ? 59 : eTimeParts[1];

            const start = new Date(sParts[0], sParts[1] - 1, sParts[2], sHour, sMin, 0, 0);
            const end = new Date(eParts[0], eParts[1] - 1, eParts[2], eHour, eMin, 59, 999);

            const now = new Date();
            return now >= start && now <= end;
        } catch (e) {
            console.error("isSystemOpen 判斷錯誤:", e);
            return false;
        }
    },

    login(role) {
        if (role === 'user') {
            const classInput = document.getElementById('class-input');
            const passwordInput = document.getElementById('user-password-input');
            const className = classInput.value.trim();
            const password = passwordInput ? passwordInput.value.trim() : '';
            
            if (!className || !password) {
                alert('請完整輸入班級與密碼才能登入！');
                classInput.focus();
                return;
            }
            
            const userRecord = this.systemUsers[className];
            if (!userRecord || userRecord.password !== password) {
                alert('登入失敗：班級或密碼錯誤。如果您還沒有帳號，請聯繫管理者。');
                return;
            }

            // 更新最後登入時間
            this.systemUsers[className].lastLoginTime = new Date().toLocaleString('zh-TW');
            this.saveState();

            this.currentUser = className;
            
            // 初始化草稿：讀取此使用者已經確認過的課程
            this.draftSelections = [];
            for (const [courseId, users] of Object.entries(this.selectedCourses)) {
                if (users.includes(this.currentUser)) {
                    this.draftSelections.push(courseId);
                }
            }
            this.logActivity(className, '登入', '一般使用者成功登入系統');
        } else {
            const adminPasswordInput = document.getElementById('admin-password-input');
            const password = adminPasswordInput ? adminPasswordInput.value.trim() : '';
            if (password !== (this.systemSettings.adminPassword || 'admin')) {
                alert('管理者密碼錯誤！');
                return;
            }
            this.currentUser = 'Admin';
            this.logActivity('Admin', '登入', '管理者成功登入系統');
        }

        this.mode = role;

        // 儲存 Session 至 localStorage 以支援 F5 保持登入
        try {
            localStorage.setItem('course_system_session', JSON.stringify({
                mode: role,
                currentUser: this.currentUser
            }));
        } catch (e) {
            console.warn("無法寫入 localStorage 進行 Session 保持:", e);
        }

        this.activateAppView(role);
    },

    // 切換至系統主視圖
    activateAppView(role) {
        this.mode = role;
        document.getElementById('login-screen').classList.remove('active');
        document.getElementById('app-screen').classList.add('active');
        
        const badge = document.getElementById('mode-badge');
        const adminControls = document.getElementById('admin-controls');
        const userControls = document.getElementById('user-controls');
        const welcomeMessage = document.getElementById('welcome-message');
        const scheduleContainer = document.getElementById('main-schedule-container');
        const tabSchedule = document.getElementById('tab-schedule');
        
        welcomeMessage.textContent = `歡迎，${this.currentUser}`;

        if (role === 'admin') {
            badge.textContent = '管理者模式';
            badge.style.background = '#e74c3c';
            adminControls.style.display = 'block';
            userControls.style.display = 'none';
            document.body.classList.add('admin-mode');
            
            // 載入目前設定
            const startInput = document.getElementById('admin-start-date');
            const startTimeInput = document.getElementById('admin-start-time');
            const endInput = document.getElementById('admin-end-date');
            const endTimeInput = document.getElementById('admin-end-time');
            if (startInput && endInput) {
                startInput.value = this.systemSettings.openStartDate || '';
                if (startTimeInput) startTimeInput.value = this.systemSettings.openStartTime || '08:00';
                endInput.value = this.systemSettings.openEndDate || '';
                if (endTimeInput) endTimeInput.value = this.systemSettings.openEndTime || '17:00';
            }
            this.renderUserList();
            this.renderLoginStatusList();

            // 將課表移入管理者分頁 4 的卡片內部
            if (scheduleContainer && tabSchedule) {
                tabSchedule.appendChild(scheduleContainer);
            }

            this.switchAdminTab('tab-time');
            
        } else {
            badge.textContent = '一般使用者';
            badge.style.background = '#2c3e50';
            adminControls.style.display = 'none';
            userControls.style.display = 'block';
            document.body.classList.remove('admin-mode');
            
            // 將課表移回一般使用者主畫面
            if (scheduleContainer && userControls) {
                userControls.after(scheduleContainer);
                scheduleContainer.style.display = 'block';
            }
            
            this.updateUserOpenStatusUI();
        }
        
        this.renderSchedule();
    },

    // 更新使用者選課限制與狀態 UI
    updateUserOpenStatusUI() {
        const userControls = document.getElementById('user-controls');
        const submitBtn = document.getElementById('submit-btn');
        const instruction = document.getElementById('user-instruction');
        if (!userControls || !submitBtn || !instruction) return;

        if (this.isSystemOpen()) {
            submitBtn.style.display = 'block';
            userControls.classList.remove('readonly-mode');
            instruction.innerHTML = `<strong>選課限制：</strong>每人限選 <span class="highlight">1</span> 節課。每個課程限額 <span class="highlight">2</span> 人。<br><small style="color: #666;">（請注意：選擇後必須點擊右方按鈕才能完成存檔）</small>`;
        } else {
            submitBtn.style.display = 'none';
            userControls.classList.add('readonly-mode');
            instruction.innerHTML = `<strong>注意：目前非開放選課期間。</strong><br><small>您僅能檢視目前的選課狀態，無法進行修改與存檔。</small>`;
        }
    },

    logout() {
        if (this.currentUser) {
            this.logActivity(this.currentUser, '登出', '使用者登出系統');
        }
        this.mode = null;
        this.currentUser = null;
        this.draftSelections = [];
        try {
            localStorage.removeItem('course_system_session');
        } catch (e) {
            console.warn("無法清除 localStorage Session:", e);
        }
        document.getElementById('class-input').value = '';
        if (document.getElementById('user-password-input')) document.getElementById('user-password-input').value = '';
        if (document.getElementById('admin-password-input')) document.getElementById('admin-password-input').value = '';
        document.getElementById('app-screen').classList.remove('active');
        document.getElementById('login-screen').classList.add('active');

        const scheduleContainer = document.getElementById('main-schedule-container');
        const userControls = document.getElementById('user-controls');
        if (scheduleContainer && userControls) {
            userControls.after(scheduleContainer);
            scheduleContainer.style.display = 'block';
        }

        this.updateAnnouncement();
    },

    addUser() {
        const className = document.getElementById('new-user-class').value.trim();
        const password = document.getElementById('new-user-password').value.trim();

        if (!className || !password) {
            alert('請完整輸入班級與密碼！');
            return;
        }

        // 格式驗證：三位數字 (如 101)
        const classRegex = /^[1-6][0-9]{2}$/;
        if (!classRegex.test(className)) {
            alert('帳號格式錯誤！\n必須為三位數字（例如：101 代表一年一班）。\n第一碼為年級 (1-6)，後兩碼為班級 (01-99)。');
            document.getElementById('new-user-class').value = ''; // 格式錯誤時刪除原始輸入
            document.getElementById('new-user-password').value = ''; // 密碼也同步清除
            return;
        }

        if (this.systemUsers[className]) {
            alert('此帳號已存在！');
            return;
        }

        const existing = typeof this.systemUsers[className] === 'object' ? this.systemUsers[className] : {};
        this.systemUsers[className] = { ...existing, password };
        this.saveState();
        this.logActivity('Admin', '新增帳號', `新增班級帳號 [${className}]`);
        this.renderUserList();
        this.renderLoginStatusList();
        
        document.getElementById('new-user-class').value = '';
        document.getElementById('new-user-password').value = '';
        alert('新增成功！');
    },

    // 輔助函式：將班級名稱依年級與班級排序
    getSortedUserNames() {
        return Object.keys(this.systemUsers).sort((a, b) => {
            return parseInt(a) - parseInt(b);
        });
    },

    deleteUser(className) {
        if (confirm(`確定要刪除帳號「${className}」嗎？\n系統將同步刪除該班級的選課紀錄。`)) {
            // 同步刪除選課紀錄
            for (let key in this.selectedCourses) {
                if (Array.isArray(this.selectedCourses[key])) {
                    this.selectedCourses[key] = this.selectedCourses[key].filter(u => u !== className);
                }
            }
            
            delete this.systemUsers[className];
            this.saveState();
            this.logActivity('Admin', '刪除帳號', `刪除班級帳號 [${className}] 及其所有選課紀錄`);
            this.renderUserList();
            this.renderLoginStatusList();
            this.renderSchedule(); // 重新渲染課表以反應變更
        }
    },

    clearUserSelection(className) {
        if (confirm(`確定要清除班級「${className}」的選課紀錄嗎？`)) {
            for (let key in this.selectedCourses) {
                if (Array.isArray(this.selectedCourses[key])) {
                    this.selectedCourses[key] = this.selectedCourses[key].filter(u => u !== className);
                }
            }
            this.saveState();
            this.logActivity('Admin', '清除選課', `手動清除班級 [${className}] 的選課紀錄`);
            this.renderLoginStatusList();
            this.renderSchedule();
            alert('選課紀錄已清除！');
        }
    },

    removeCourseRegistration(className, courseId) {
        if (confirm(`確定要移除「${className}」在該時段的選課嗎？`)) {
            if (this.selectedCourses[courseId]) {
                this.selectedCourses[courseId] = this.selectedCourses[courseId].filter(u => u !== className);
                this.saveState();
                this.logActivity('Admin', '移除單堂選課', `移除 [${className}] 在 ${this.formatCourseId(courseId)} 的選課紀錄`);
                this.renderSchedule();
                this.renderLoginStatusList();
            }
        }
    },

    switchAdminTab(tabId) {
        const btns = document.querySelectorAll('.tab-btn');
        btns.forEach(btn => btn.classList.remove('active'));
        const activeBtn = Array.from(btns).find(b => b.getAttribute('onclick') && b.getAttribute('onclick').includes(tabId));
        if (activeBtn) activeBtn.classList.add('active');

        const panes = document.querySelectorAll('.tab-pane');
        panes.forEach(pane => pane.classList.remove('active'));
        document.getElementById(tabId).classList.add('active');

        const scheduleContainer = document.getElementById('main-schedule-container');
        const tabSchedule = document.getElementById('tab-schedule');
        if (this.mode === 'admin' && scheduleContainer && tabSchedule) {
            if (tabId === 'tab-schedule') {
                tabSchedule.appendChild(scheduleContainer);
                scheduleContainer.style.display = 'block';
            } else {
                scheduleContainer.style.display = 'none';
            }
        }

        if (tabId === 'tab-analytics') {
            const activeSubTab = this.currentAnalyticsSubTab || 'subtab-user-logs';
            this.switchAnalyticsSubTab(activeSubTab);
        }
    },

    switchAnalyticsSubTab(subTabId) {
        this.currentAnalyticsSubTab = subTabId;
        const btns = document.querySelectorAll('.sub-tab-btn');
        btns.forEach(btn => btn.classList.remove('active'));
        const activeBtn = Array.from(btns).find(b => b.getAttribute('onclick') && b.getAttribute('onclick').includes(subTabId));
        if (activeBtn) activeBtn.classList.add('active');

        const panes = document.querySelectorAll('.subtab-pane');
        panes.forEach(pane => pane.style.display = 'none');
        const activePane = document.getElementById(subTabId);
        if (activePane) activePane.style.display = 'block';

        if (subTabId === 'subtab-user-logs') {
            this.resetUserLogsView();
            this.updateUserSelectDropdown();
        } else if (subTabId === 'subtab-range-logs') {
            this.resetTimeRangeLogsView();
        } else if (subTabId === 'subtab-heatmap') {
            if (!document.getElementById('heatmap-start').value) {
                this.setFilterPreset('heatmap', '7days');
            } else {
                this.loadHeatmapData();
            }
        } else if (subTabId === 'subtab-line-chart') {
            if (!document.getElementById('line-chart-start').value) {
                this.setFilterPreset('line-chart', '7days');
            } else {
                this.loadLineChartData();
            }
        } else if (subTabId === 'subtab-peak-stats') {
            if (!document.getElementById('peak-stats-start').value) {
                this.setFilterPreset('peak-stats', '7days');
            } else {
                this.loadPeakStatsData();
            }
        }
    },

    changeUserPassword(className) {
        const newPassword = prompt(`請輸入帳號「${className}」的新密碼：`);
        if (newPassword !== null) {
            const trimmedPassword = newPassword.trim();
            if (trimmedPassword === '') {
                alert('密碼不能為空白！');
                return;
            }
        if (typeof this.systemUsers[className] === 'string') {
            this.systemUsers[className] = { password: trimmedPassword };
        } else {
            this.systemUsers[className] = {
                ...this.systemUsers[className],
                password: trimmedPassword
            };
        }
        this.saveState();
        this.logActivity('Admin', '修改使用者密碼', `修改班級 [${className}] 的登入密碼`);
        this.renderUserList();
        this.renderLoginStatusList();
        alert('密碼修改成功！');
        }
    },

    async renderLoginStatusList() {
        const tbody = document.getElementById('status-list-body');
        if (!tbody) return;
        tbody.innerHTML = '';
        
        // 計算所有已選課的帳號
        const allSelectedUsers = new Set();
        for (const [courseId, users] of Object.entries(this.selectedCourses)) {
            users.forEach(u => allSelectedUsers.add(u));
        }

        const sortedClassNames = this.getSortedUserNames();

        // 檢查是否有使用者欠缺 lastLoginTime，若有則非同步從 logs 集合中備援載入最新登入時間
        let recentLogsMap = {};
        const missingLogins = sortedClassNames.some(name => {
            const data = this.systemUsers[name];
            return !data || (typeof data === 'object' && !data.lastLoginTime);
        });

        if (missingLogins) {
            try {
                const snapshot = await db.collection('logs').get();
                snapshot.forEach(doc => {
                    const logData = doc.data();
                    if (logData.userId && logData.action === '登入') {
                        const existing = recentLogsMap[logData.userId];
                        if (!existing || (logData.timestamp && logData.timestamp > existing.timestamp)) {
                            recentLogsMap[logData.userId] = logData;
                        }
                    }
                });
            } catch (e) {
                console.warn("備援讀取登入紀錄失敗:", e);
            }
        }

        let stateNeedsSave = false;

        for (const className of sortedClassNames) {
            let data = this.systemUsers[className];
            if (typeof data === 'string') {
                data = { password: data };
                this.systemUsers[className] = data;
            }

            let displayLoginTime = (data && data.lastLoginTime) ? data.lastLoginTime : null;

            if (!displayLoginTime && recentLogsMap[className]) {
                displayLoginTime = recentLogsMap[className].timeString;
                if (this.systemUsers[className] && typeof this.systemUsers[className] === 'object') {
                    this.systemUsers[className].lastLoginTime = displayLoginTime;
                    stateNeedsSave = true;
                }
            }

            const tr = document.createElement('tr');
            
            const tdClass = document.createElement('td');
            tdClass.textContent = className;
            
            const tdLastLogin = document.createElement('td');
            tdLastLogin.textContent = displayLoginTime || '從未登入';
            
            const tdStatus = document.createElement('td');
            const hasSelected = allSelectedUsers.has(className);
            if (hasSelected) {
                tdStatus.innerHTML = '<span style="color: #27ae60; font-weight: bold;">已完成選課</span>';
            } else {
                tdStatus.innerHTML = '<span style="color: #e74c3c; font-weight: bold;">未選課</span>';
            }
            
            const tdAction = document.createElement('td');
            if (hasSelected) {
                const clearBtn = document.createElement('button');
                clearBtn.className = 'btn';
                clearBtn.style.padding = '2px 8px';
                clearBtn.style.fontSize = '0.85em';
                clearBtn.style.background = '#e67e22';
                clearBtn.style.color = 'white';
                clearBtn.style.border = 'none';
                clearBtn.style.borderRadius = '4px';
                clearBtn.style.cursor = 'pointer';
                clearBtn.textContent = '清除選課';
                clearBtn.onclick = () => this.clearUserSelection(className);
                tdAction.appendChild(clearBtn);
            } else {
                tdAction.textContent = '-';
            }
            
            tr.appendChild(tdClass);
            tr.appendChild(tdLastLogin);
            tr.appendChild(tdStatus);
            tr.appendChild(tdAction);
            
            tbody.appendChild(tr);
        }

        if (stateNeedsSave) {
            this.saveState();
        }
    },

    renderUserList() {
        const tbody = document.getElementById('user-list-body');
        if (!tbody) return;
        tbody.innerHTML = '';
        
        const sortedClassNames = this.getSortedUserNames();
        
        for (const className of sortedClassNames) {
            const data = this.systemUsers[className];
            const tr = document.createElement('tr');
            
            const tdClass = document.createElement('td');
            tdClass.textContent = className;
            
            const tdPassword = document.createElement('td');
            tdPassword.textContent = data.password;
            
            const tdAction = document.createElement('td');
            tdAction.style.display = 'flex';
            tdAction.style.gap = '5px';
            tdAction.style.justifyContent = 'center';

            const pwdBtn = document.createElement('button');
            pwdBtn.className = 'btn';
            pwdBtn.style.padding = '2px 8px';
            pwdBtn.style.background = '#3498db';
            pwdBtn.style.color = 'white';
            pwdBtn.style.border = 'none';
            pwdBtn.style.borderRadius = '4px';
            pwdBtn.style.cursor = 'pointer';
            pwdBtn.textContent = '修改密碼';
            pwdBtn.onclick = () => this.changeUserPassword(className);

            const delBtn = document.createElement('button');
            delBtn.className = 'btn';
            delBtn.style.padding = '2px 8px';
            delBtn.style.background = '#e74c3c';
            delBtn.style.color = 'white';
            delBtn.style.border = 'none';
            delBtn.style.borderRadius = '4px';
            delBtn.style.cursor = 'pointer';
            delBtn.textContent = '刪除';
            delBtn.onclick = () => this.deleteUser(className);

            tdAction.appendChild(pwdBtn);
            tdAction.appendChild(delBtn);
            
            tr.appendChild(tdClass);
            tr.appendChild(tdPassword);
            tr.appendChild(tdAction);
            
            tbody.appendChild(tr);
        }
    },

    changeAdminPassword() {
        const newPassword = prompt('請輸入新的管理者密碼：');
        if (newPassword === null) return;
        const trimmed = newPassword.trim();
        if (!trimmed) {
            alert('密碼不能為空白！');
            return;
        }
        const confirmPwd = prompt('請再次輸入新密碼以確認：');
        if (confirmPwd !== trimmed) {
            alert('兩次輸入的密碼不一致！');
            return;
        }
        this.systemSettings.adminPassword = trimmed;
        this.saveState();
        this.logActivity('Admin', '修改管理者密碼', '管理者變更登入密碼成功');
        alert('管理者密碼修改成功！下次登入請使用新密碼。');
    },

    downloadSampleExcel() {
        if (typeof XLSX === 'undefined') {
            alert('系統尚未載入 SheetJS，請確認網路連線！');
            return;
        }
        const ws = XLSX.utils.aoa_to_sheet([["班級", "密碼"], ["101", "1234"], ["605", "1234"]]);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Users");
        XLSX.writeFile(wb, "使用者匯入範例.xlsx");
    },

    handleExcelUpload(event) {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = new Uint8Array(e.target.result);
                const workbook = XLSX.read(data, { type: 'array' });
                const firstSheetName = workbook.SheetNames[0];
                const worksheet = workbook.Sheets[firstSheetName];
                const json = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
                
                if (json.length === 0) return;
                const headers = json[0];
                let classIdx = headers.indexOf('班級');
                let passwordIdx = headers.indexOf('密碼');
                
                if (classIdx === -1) classIdx = 0;
                if (passwordIdx === -1) passwordIdx = 1;

                let count = 0;
                let skipCount = 0;
                const classRegex = /^[1-6][0-9]{2}$/;

                for (let i = 1; i < json.length; i++) {
                    const row = json[i];
                    if (!row || row.length === 0) continue;
                    
                    const className = row[classIdx] ? String(row[classIdx]).trim() : '';
                    const password = row[passwordIdx] ? String(row[passwordIdx]).trim() : '';
                    
                    if (className && password) {
                        if (classRegex.test(className)) {
                            const existing = typeof this.systemUsers[className] === 'object' ? this.systemUsers[className] : {};
                            this.systemUsers[className] = { ...existing, password };
                            count++;
                        } else {
                            skipCount++;
                        }
                    }
                }
                
                this.saveState();
                this.logActivity('Admin', '批次匯入帳號', `成功透過 Excel 批次匯入/更新 ${count} 筆帳號`);
                this.renderUserList();
                this.renderLoginStatusList();
                
                let msg = `匯入完成！成功新增或更新 ${count} 筆資料。`;
                if (skipCount > 0) {
                    msg += `\n有 ${skipCount} 筆資料因格式不符（須為三位數字，如 101）而被跳過。`;
                }
                alert(msg);
            } catch (err) {
                console.error(err);
                alert('解析 Excel 檔案失敗，請確定檔案格式正確且有網路連線以載入 SheetJS。');
            }
            event.target.value = ''; // 清除選擇的檔案
        };
        reader.readAsArrayBuffer(file);
    },

    saveSystemSettings() {
        const start = document.getElementById('admin-start-date').value;
        const startTime = document.getElementById('admin-start-time').value;
        const end = document.getElementById('admin-end-date').value;
        const endTime = document.getElementById('admin-end-time').value;
        
        if (!start || !end) {
            alert("請選擇完整的開始與結束日期！");
            return;
        }

        try {
            const [sY, sM, sD] = start.split('-').map(Number);
            const [eY, eM, eD] = end.split('-').map(Number);
            const [sH, sMin] = (startTime || '00:00').split(':').map(Number);
            const [eH, eMin] = (endTime || '23:59').split(':').map(Number);

            const startDt = new Date(sY, sM - 1, sD, sH || 0, sMin || 0, 0);
            const endDt = new Date(eY, eM - 1, eD, eH || 23, eMin || 59, 59);

            if (startDt > endDt) {
                alert("開始時間不能晚於結束時間！");
                return;
            }
        } catch (e) {
            console.error("時間解析失敗:", e);
        }

        this.systemSettings.openStartDate = start;
        this.systemSettings.openStartTime = startTime || '';
        this.systemSettings.openEndDate = end;
        this.systemSettings.openEndTime = endTime || '';
        this.saveState();
        this.logActivity('Admin', '修改開放時間', `開放時間變更為 ${start} ${startTime || '00:00'} ~ ${end} ${endTime || '23:59'}`);
        alert("設定已儲存！");
    },

    toggleCourseSelection(dayId, periodId) {
        if (this.mode === 'admin') return; 
        if (!this.isSystemOpen()) {
            alert('目前不在開放選課期間內，無法修改選課。');
            return;
        }

        const courseId = `${dayId}-${periodId}`;
        const draftIndex = this.draftSelections.indexOf(courseId);

        if (draftIndex !== -1) {
            // 已經選過，取消選取
            this.draftSelections.splice(draftIndex, 1);
        } else {
            // 尚未選取，檢查限制 (1節)
            if (this.draftSelections.length >= 1) {
                // 如果已經選了1節，自動取消上一節，改選這節（或可設計為阻擋）
                // 這裡採用「自動覆蓋上一堂課」的體驗，或者跳警告。
                // 需求是「只能選一堂」，所以我們直接清空陣列並加入新的
                this.draftSelections = [];
            }
            
            // 檢查該堂課是否已額滿 (扣除自己原先可能的選取)
            const enrolledUsers = this.selectedCourses[courseId] || [];
            const otherUsers = enrolledUsers.filter(u => u !== this.currentUser);
            if (otherUsers.length >= 2) {
                alert('該課程已經額滿！');
                return;
            }

            // 新增至草稿
            this.draftSelections.push(courseId);
        }

        this.renderSchedule();
    },

    async submitSelections() {
        if (!this.isSystemOpen()) {
            alert('非選課期間，無法送出！');
            return;
        }

        if (this.draftSelections.length === 0) {
            alert('至少要選擇一次課程才能送出！');
            return;
        }

        try {
            // 使用 Firestore Transaction (事務處理) 讀取與驗證最新狀態，防範多人同時存檔造成的競爭與超額情況
            await db.runTransaction(async (transaction) => {
                const coursesRef = db.collection('system').doc('courses');
                const doc = await transaction.get(coursesRef);
                const currentServerCourses = doc.exists ? doc.data() : {};

                // 驗證草稿中選取的每一個課程時段是否在最新雲端資料中已額滿 (≥ 2 人)
                for (const courseId of this.draftSelections) {
                    const enrolledUsers = (currentServerCourses[courseId] || []).filter(u => u !== this.currentUser);
                    if (enrolledUsers.length >= 2) {
                        throw new Error("COURSE_FULL");
                    }
                }

                // 清除該使用者所有舊的選課紀錄
                for (let key in currentServerCourses) {
                    if (Array.isArray(currentServerCourses[key])) {
                        currentServerCourses[key] = currentServerCourses[key].filter(u => u !== this.currentUser);
                    }
                }

                // 將草稿寫入最新正式紀錄
                for (const courseId of this.draftSelections) {
                    if (!Array.isArray(currentServerCourses[courseId])) {
                        currentServerCourses[courseId] = [];
                    }
                    if (!currentServerCourses[courseId].includes(this.currentUser)) {
                        currentServerCourses[courseId].push(this.currentUser);
                    }
                }

                transaction.set(coursesRef, currentServerCourses);
                this.selectedCourses = currentServerCourses;

                const selectedStr = this.draftSelections.map(id => this.formatCourseId(id)).join(', ');
                this.logActivity(this.currentUser, '選課存檔', `成功儲存選課時段: ${selectedStr}`);
            });

            alert('選課存檔成功！');
            this.renderSchedule();
        } catch (error) {
            if (error.message === "COURSE_FULL") {
                // 從雲端重新讀取最新課表
                try {
                    const doc = await db.collection('system').doc('courses').get();
                    if (doc.exists) {
                        this.selectedCourses = doc.data() || {};
                    }
                } catch (e) {
                    console.error("重新獲取選課資料失敗:", e);
                }
                alert("該課程時段已額滿，請選擇其他時段。");
                this.renderSchedule();
            } else {
                console.error("存檔失敗:", error);
                alert("選課存檔失敗，請檢查網路連線或稍後再試！");
            }
        }
    },

    renderSchedule() {
        const headerTr = document.getElementById('schedule-header');
        headerTr.innerHTML = '<th class="time-col">節次</th>';
        
        this.weekdays.forEach(day => {
            const th = document.createElement('th');
            th.className = 'date-header';
            th.textContent = day.name;
            headerTr.appendChild(th);
        });

        const bodyTbody = document.getElementById('schedule-body');
        bodyTbody.innerHTML = '';

        const periods = [
            { id: 'm1', name: '早上<br>第1節' },
            { id: 'm2', name: '早上<br>第2節' },
            { id: 'm3', name: '早上<br>第3節' },
            { id: 'm4', name: '早上<br>第4節' },
            { id: 'break', name: '中午休息', isBreak: true },
            { id: 'a1', name: '下午<br>第1節' },
            { id: 'a2', name: '下午<br>第2節' },
            { id: 'a3', name: '下午<br>第3節' }
        ];

        periods.forEach(period => {
            const tr = document.createElement('tr');
            if (period.isBreak) {
                tr.className = 'noon-break';
                const td = document.createElement('td');
                td.colSpan = 6;
                td.textContent = period.name;
                tr.appendChild(td);
            } else {
                const th = document.createElement('th');
                th.className = 'time-col';
                th.innerHTML = period.name;
                tr.appendChild(th);

                this.weekdays.forEach(day => {
                    const td = document.createElement('td');
                    const courseId = `${day.id}-${period.id}`;
                    
                    const enrolledUsers = this.selectedCourses[courseId] || [];

                    td.className = 'course-cell';
                    
                    if (this.mode === 'admin') {
                        // 管理者視角：直接顯示已存檔的名單
                        td.innerHTML = `<div>開放選課</div>`;
                        if (enrolledUsers.length > 0) {
                            td.classList.add('selected');
                            const userListDiv = document.createElement('div');
                            userListDiv.className = 'user-list';
                            enrolledUsers.forEach(u => {
                                const span = document.createElement('span');
                                span.className = 'user-tag';
                                span.style.display = 'flex';
                                span.style.alignItems = 'center';
                                span.style.gap = '5px';
                                span.innerHTML = `${u} <span class="tag-delete" title="移除選課" style="cursor:pointer; font-weight:bold; font-size:1.2em; line-height:1;">&times;</span>`;
                                
                                // 綁定刪除事件
                                const delBtn = span.querySelector('.tag-delete');
                                delBtn.onclick = (e) => {
                                    e.stopPropagation();
                                    this.removeCourseRegistration(u, courseId);
                                };
                                
                                userListDiv.appendChild(span);
                            });
                            td.appendChild(userListDiv);
                        } else {
                            td.innerHTML += `<div style="font-size:0.8em;color:#777;margin-top:5px;">(無人選取)</div>`;
                        }
                    } else {
                        // 一般使用者視角
                        const isSelectedInDraft = this.draftSelections.includes(courseId);
                        const otherUsers = enrolledUsers.filter(u => u !== this.currentUser);
                        const isFull = otherUsers.length >= 2;
                        const isSystemOpen = this.isSystemOpen();

                        let statusHtml = '';

                        if (isSelectedInDraft) {
                            td.classList.add('selected');
                            statusHtml = isSystemOpen ? '已選取<br><small style="font-size:0.7em;">(點擊取消)</small>' : '您已選取這堂課';
                        } else if (isFull) {
                            td.classList.add('disabled');
                            statusHtml = '已額滿';
                        } else {
                            if (!isSystemOpen) {
                                td.classList.add('disabled');
                                statusHtml = '非開放期間';
                            } else {
                                statusHtml = '點擊選課';
                            }
                        }

                        let displayUsers = [...otherUsers];
                        if (isSelectedInDraft) {
                            if (enrolledUsers.includes(this.currentUser)) {
                                displayUsers.push(this.currentUser);
                            } else {
                                displayUsers.push(this.currentUser + ' (未存檔)');
                            }
                        }

                        let usersHtml = '';
                        if (displayUsers.length > 0) {
                            usersHtml = '<div class="user-list" style="margin-top: 8px;">';
                            displayUsers.forEach(u => {
                                usersHtml += `<span class="user-tag" style="font-size: 0.85em; padding: 3px 6px; margin: 2px;">${u}</span>`;
                            });
                            usersHtml += '</div>';
                        }

                        td.innerHTML = `<div>${statusHtml}</div>${usersHtml}`;
                        
                        // 點擊事件
                        td.onclick = () => {
                            if (isSystemOpen && (!isFull || isSelectedInDraft)) {
                                this.toggleCourseSelection(day.id, period.id);
                            }
                        };
                    }
                    
                    tr.appendChild(td);
                });
            }
            bodyTbody.appendChild(tr);
        });
    },

    // 數位軌跡紀錄核心輔助函式
    async logActivity(userId, action, details) {
        try {
            const now = new Date();
            const logEntry = {
                timestamp: now.getTime(),
                timeString: now.toLocaleString('zh-TW', { hour12: false }),
                userId: userId || 'Unknown',
                action: action || '',
                details: details || ''
            };
            await db.collection('logs').add(logEntry);
        } catch (error) {
            console.error("記錄數位軌跡失敗:", error);
        }
    },

    formatCourseId(courseId) {
        const periodMap = {
            'm1': '早上第1節',
            'm2': '早上第2節',
            'm3': '早上第3節',
            'm4': '早上第4節',
            'a1': '下午第1節',
            'a2': '下午第2節',
            'a3': '下午第3節'
        };
        const dayMap = {
            'mon': '星期一',
            'tue': '星期二',
            'wed': '星期三',
            'thu': '星期四',
            'fri': '星期五'
        };
        const parts = String(courseId).split('-');
        if (parts.length < 2) return courseId;
        return `${dayMap[parts[0]] || parts[0]} ${periodMap[parts[1]] || parts[1]}`;
    },

    resetUserLogsView() {
        this.currentUserLogsData = [];
        const select = document.getElementById('query-user-select');
        if (select) select.value = '';
        const tbody = document.getElementById('user-logs-list-body');
        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="4" style="color: #888;">請選擇使用者並點擊「查詢紀錄」</td></tr>';
        }
    },

    resetTimeRangeLogsView() {
        this.currentTimeRangeLogsData = [];
        const startInput = document.getElementById('query-range-start');
        const endInput = document.getElementById('query-range-end');
        if (startInput && endInput) {
            const now = new Date();
            const year = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const day = String(now.getDate()).padStart(2, '0');
            startInput.value = `${year}-${month}-${day}T00:00`;
            endInput.value = `${year}-${month}-${day}T23:59`;
        }
        const tbody = document.getElementById('range-logs-list-body');
        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="4" style="color: #888;">請選擇時間區間並點擊「查詢軌跡」</td></tr>';
        }
    },

    updateUserSelectDropdown() {
        const select = document.getElementById('query-user-select');
        if (!select) return;
        
        const currentValue = select.value;
        select.innerHTML = '<option value="">-- 請選擇班級帳號 --</option>';
        
        const adminOpt = document.createElement('option');
        adminOpt.value = 'Admin';
        adminOpt.textContent = 'Admin (管理者)';
        select.appendChild(adminOpt);

        const sortedNames = this.getSortedUserNames();
        for (const name of sortedNames) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = `${name} 班`;
            select.appendChild(opt);
        }

        if (currentValue) {
            select.value = currentValue;
        }
    },

    async searchUserLogs() {
        const select = document.getElementById('query-user-select');
        const targetUser = select ? select.value.trim() : '';
        if (!targetUser) {
            alert('請先選擇要查詢的班級或管理者帳號！');
            return;
        }

        const tbody = document.getElementById('user-logs-list-body');
        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="4" style="color: #666;">載入中...</td></tr>';
        }

        try {
            const snapshot = await db.collection('logs').get();
            let logs = [];
            snapshot.forEach(doc => {
                const data = doc.data();
                if (data.userId === targetUser) {
                    logs.push(data);
                }
            });

            logs.sort((a, b) => b.timestamp - a.timestamp);
            this.currentUserLogsData = logs;

            if (!tbody) return;
            tbody.innerHTML = '';

            if (logs.length === 0) {
                tbody.innerHTML = `<tr><td colspan="4" style="color: #888;">查無「${targetUser}」的數位軌跡紀錄</td></tr>`;
                return;
            }

            logs.forEach(log => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td>${log.timeString || '-'}</td>
                    <td><span class="user-tag" style="background:#34495e;">${log.userId}</span></td>
                    <td style="font-weight:bold; color:#2980b9;">${log.action || '-'}</td>
                    <td style="text-align:left;">${log.details || '-'}</td>
                `;
                tbody.appendChild(tr);
            });
        } catch (error) {
            console.error("查詢使用者軌跡失敗:", error);
            alert("查詢失敗，請檢查網路連線！");
        }
    },

    exportUserLogsExcel() {
        const select = document.getElementById('query-user-select');
        const targetUser = select ? select.value.trim() : '';
        if (!targetUser || this.currentUserLogsData.length === 0) {
            alert('目前沒有可匯出的查詢結果紀錄，請先選擇帳號並點擊「查詢紀錄」！');
            return;
        }

        if (typeof XLSX === 'undefined') {
            alert('系統尚未載入 SheetJS，請確認網路連線！');
            return;
        }

        const excelData = this.currentUserLogsData.map(item => ({
            "時間": item.timeString || '',
            "帳號/班級": item.userId || '',
            "動作項目": item.action || '',
            "詳細說明": item.details || ''
        }));

        const ws = XLSX.utils.json_to_sheet(excelData);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "使用者數位軌跡");
        XLSX.writeFile(wb, `使用者[${targetUser}]_數位軌跡紀錄.xlsx`);
    },

    async searchTimeRangeLogs() {
        const startInput = document.getElementById('query-range-start');
        const endInput = document.getElementById('query-range-end');
        
        if (!startInput || !endInput || !startInput.value || !endInput.value) {
            alert('請完整選擇查詢的開始與結束時間！');
            return;
        }

        const startMs = new Date(startInput.value).getTime();
        const endMs = new Date(endInput.value).getTime();

        if (startMs > endMs) {
            alert('開始時間不能晚於結束時間！');
            return;
        }

        const tbody = document.getElementById('range-logs-list-body');
        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="4" style="color: #666;">載入中...</td></tr>';
        }

        try {
            const snapshot = await db.collection('logs').get();
            let logs = [];
            snapshot.forEach(doc => {
                const data = doc.data();
                if (data.timestamp >= startMs && data.timestamp <= endMs) {
                    logs.push(data);
                }
            });

            logs.sort((a, b) => b.timestamp - a.timestamp);
            this.currentTimeRangeLogsData = logs;

            if (!tbody) return;
            tbody.innerHTML = '';

            if (logs.length === 0) {
                tbody.innerHTML = `<tr><td colspan="4" style="color: #888;">此時間區間內查無數位軌跡紀錄</td></tr>`;
                return;
            }

            logs.forEach(log => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td>${log.timeString || '-'}</td>
                    <td><span class="user-tag" style="background:#34495e;">${log.userId}</span></td>
                    <td style="font-weight:bold; color:#2980b9;">${log.action || '-'}</td>
                    <td style="text-align:left;">${log.details || '-'}</td>
                `;
                tbody.appendChild(tr);
            });
        } catch (error) {
            console.error("查詢時間區間軌跡失敗:", error);
            alert("查詢失敗，請檢查網路連線！");
        }
    },

    exportTimeRangeLogsExcel() {
        if (this.currentTimeRangeLogsData.length === 0) {
            alert('目前沒有可匯出的查詢結果紀錄，請先設定時間區間並點擊「查詢軌跡」！');
            return;
        }

        if (typeof XLSX === 'undefined') {
            alert('系統尚未載入 SheetJS，請確認網路連線！');
            return;
        }

        const startVal = document.getElementById('query-range-start').value.replace('T', ' ');
        const endVal = document.getElementById('query-range-end').value.replace('T', ' ');

        const excelData = this.currentTimeRangeLogsData.map(item => ({
            "時間": item.timeString || '',
            "帳號/班級": item.userId || '',
            "動作項目": item.action || '',
            "詳細說明": item.details || ''
        }));

        const ws = XLSX.utils.json_to_sheet(excelData);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "時間區間數位軌跡");
        XLSX.writeFile(wb, `數位軌跡紀錄_${startVal}至${endVal}.xlsx`);
    },

    setFilterPreset(target, presetType) {
        const startInput = document.getElementById(`${target}-start`);
        const endInput = document.getElementById(`${target}-end`);
        if (!startInput || !endInput) return;

        const now = new Date();
        const endStr = this.formatDateTimeLocal(now);

        let start = new Date();
        if (presetType === 'today') {
            start.setHours(0, 0, 0, 0);
        } else if (presetType === '7days') {
            start.setDate(now.getDate() - 7);
            start.setHours(0, 0, 0, 0);
        } else if (presetType === '30days') {
            start.setDate(now.getDate() - 30);
            start.setHours(0, 0, 0, 0);
        }
        const startStr = this.formatDateTimeLocal(start);

        startInput.value = startStr;
        endInput.value = endStr;

        if (target === 'heatmap') this.loadHeatmapData();
        else if (target === 'line-chart') this.loadLineChartData();
        else if (target === 'peak-stats') this.loadPeakStatsData();
    },

    formatDateTimeLocal(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        return `${year}-${month}-${day}T${hours}:${minutes}`;
    },

    async fetchLogsForRange(startInputId, endInputId) {
        const startInput = document.getElementById(startInputId);
        const endInput = document.getElementById(endInputId);

        if (!startInput || !endInput || !startInput.value || !endInput.value) {
            alert('請選擇完整的開始與結束時間！');
            return null;
        }

        const startMs = new Date(startInput.value).getTime();
        const endMs = new Date(endInput.value).getTime();

        if (startMs > endMs) {
            alert('開始時間不能晚於結束時間！');
            return null;
        }

        try {
            const snapshot = await db.collection('logs').get();
            let logs = [];
            snapshot.forEach(doc => {
                const data = doc.data();
                if (data.timestamp >= startMs && data.timestamp <= endMs) {
                    logs.push(data);
                }
            });
            return { logs, startMs, endMs };
        } catch (error) {
            console.error("獲取分析紀錄失敗:", error);
            alert("獲取資料失敗，請檢查網路連線！");
            return null;
        }
    },

    async loadHeatmapData() {
        const result = await this.fetchLogsForRange('heatmap-start', 'heatmap-end');
        if (!result) return;
        const { logs } = result;

        const container = document.getElementById('heatmap-grid-container');
        const legend = document.getElementById('heatmap-legend');
        if (!container) return;

        // 建立 7 (星期一~日) x 24 (小時) 矩陣
        const dayNames = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];
        const matrix = Array.from({ length: 7 }, () => Array(24).fill(0));

        logs.forEach(log => {
            const dt = new Date(log.timestamp);
            let day = dt.getDay(); // 0 = Sun, 1 = Mon, ...
            const dayIdx = (day === 0) ? 6 : day - 1; // 轉為 0 = Mon, 6 = Sun
            const hour = dt.getHours();
            matrix[dayIdx][hour]++;
        });

        let html = '<table class="heatmap-table"><thead><tr><th style="width:75px;">星期 \\ 時段</th>';
        for (let h = 0; h < 24; h++) {
            html += `<th>${String(h).padStart(2, '0')}:00</th>`;
        }
        html += '</tr></thead><tbody>';

        for (let d = 0; d < 7; d++) {
            html += `<tr><th>${dayNames[d]}</th>`;
            for (let h = 0; h < 24; h++) {
                const count = matrix[d][h];
                let level = 'level-0';
                if (count >= 10) level = 'level-4';
                else if (count >= 6) level = 'level-3';
                else if (count >= 3) level = 'level-2';
                else if (count >= 1) level = 'level-1';

                html += `<td class="${level}" title="${dayNames[d]} ${String(h).padStart(2, '0')}:00 - 累積 ${count} 次登入與操作">${count}</td>`;
            }
            html += '</tr>';
        }
        html += '</tbody></table>';

        container.innerHTML = html;
        if (legend) legend.style.display = 'flex';
    },

    async loadLineChartData() {
        const result = await this.fetchLogsForRange('line-chart-start', 'line-chart-end');
        if (!result) return;
        const { logs, startMs, endMs } = result;

        const granularity = document.getElementById('line-chart-granularity').value;
        const diffDays = (endMs - startMs) / (1000 * 3600 * 24);

        let byDay = (granularity === 'day') || (granularity === 'auto' && diffDays > 3);

        const countsMap = {};

        function pad2(n) { return String(n).padStart(2, '0'); }

        logs.forEach(log => {
            const dt = new Date(log.timestamp);
            let key = '';
            if (byDay) {
                key = `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
            } else {
                key = `${pad2(dt.getMonth() + 1)}/${pad2(dt.getDate())} ${pad2(dt.getHours())}:00`;
            }
            countsMap[key] = (countsMap[key] || 0) + 1;
        });

        const labels = Object.keys(countsMap);
        const dataValues = Object.values(countsMap);

        const ctx = document.getElementById('loginLineChartCanvas');
        if (!ctx) return;

        if (typeof Chart === 'undefined') {
            alert('Chart.js 未成功載入，請確認網路連線！');
            return;
        }

        if (this.lineChartInstance) {
            this.lineChartInstance.destroy();
        }

        this.lineChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels.length > 0 ? labels : ['無資料'],
                datasets: [{
                    label: byDay ? '每日活躍人次' : '每小時活躍人次',
                    data: dataValues.length > 0 ? dataValues : [0],
                    borderColor: '#3498db',
                    backgroundColor: 'rgba(52, 152, 219, 0.15)',
                    fill: true,
                    tension: 0.35,
                    borderWidth: 3,
                    pointRadius: 5,
                    pointHoverRadius: 8,
                    pointBackgroundColor: '#2980b9'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: true, position: 'top' },
                    tooltip: { mode: 'index', intersect: false }
                },
                scales: {
                    y: { beginAtZero: true, ticks: { precision: 0 } },
                    x: { grid: { display: false } }
                }
            }
        });
    },

    async loadPeakStatsData() {
        const result = await this.fetchLogsForRange('peak-stats-start', 'peak-stats-end');
        if (!result) return;
        const { logs } = result;

        const hourlyCounts = Array(24).fill(0);
        logs.forEach(log => {
            const dt = new Date(log.timestamp);
            hourlyCounts[dt.getHours()]++;
        });

        let peakHour = 0, peakCount = -1;
        let offpeakHour = 0, offpeakCount = Infinity;

        hourlyCounts.forEach((count, h) => {
            if (count > peakCount) {
                peakCount = count;
                peakHour = h;
            }
            if (count < offpeakCount) {
                offpeakCount = count;
                offpeakHour = h;
            }
        });

        if (offpeakCount === Infinity) offpeakCount = 0;

        const totalLogins = logs.length;
        const avgLogins = (totalLogins / 24).toFixed(1);

        document.getElementById('kpi-peak-time').textContent = `${String(peakHour).padStart(2, '0')}:00 - ${String((peakHour + 1) % 24).padStart(2, '0')}:00`;
        document.getElementById('kpi-peak-count').textContent = `共 ${peakCount} 人次登入`;

        document.getElementById('kpi-offpeak-time').textContent = `${String(offpeakHour).padStart(2, '0')}:00 - ${String((offpeakHour + 1) % 24).padStart(2, '0')}:00`;
        document.getElementById('kpi-offpeak-count').textContent = `共 ${offpeakCount} 人次登入`;

        document.getElementById('kpi-total-logins').textContent = totalLogins;
        document.getElementById('kpi-avg-logins').textContent = avgLogins;

        const ctx = document.getElementById('peakStatsChartCanvas');
        if (!ctx) return;

        if (typeof Chart === 'undefined') return;

        if (this.peakStatsChartInstance) {
            this.peakStatsChartInstance.destroy();
        }

        const labels = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`);
        const bgColors = hourlyCounts.map((_, i) => {
            if (i === peakHour && peakCount > 0) return '#ef4444'; // 尖峰紅
            if (i === offpeakHour) return '#94a3b8'; // 離峰灰藍
            return '#38bdf8'; // 一般藍
        });

        this.peakStatsChartInstance = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: '各時段累積登入與操作人次',
                    data: hourlyCounts,
                    backgroundColor: bgColors,
                    borderRadius: 6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: true, position: 'top' },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                let label = `登入人次: ${context.parsed.y}`;
                                if (context.dataIndex === peakHour && peakCount > 0) label += ' (🔥 尖峰時段)';
                                if (context.dataIndex === offpeakHour) label += ' (❄️ 離峰時段)';
                                return label;
                            }
                        }
                    }
                },
                scales: {
                    y: { beginAtZero: true, ticks: { precision: 0 } },
                    x: { grid: { display: false } }
                }
            }
        });
    }
};

// 4. 當網頁載入完成，非同步啟動 app
window.addEventListener('DOMContentLoaded', async () => {
    await app.init();
});
