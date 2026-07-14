// ============================================================
// orders_api.js
// Express-эндпоинт для приема заказов рум-сервиса по QR-коду.
// Гость сканирует QR (site.com/room/101) -> легкая страница ->
// POST-запрос сюда -> запись в БД + уведомление персоналу.
// ============================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { notifyAdminAboutOrder } = require('./whatsapp.js'); // общий модуль отправки в WhatsApp
const router = express.Router();

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Допустимые типы услуг — защита от мусорных/произвольных значений
const ALLOWED_SERVICE_TYPES = ['утюг', 'еда', 'полотенца', 'уборка', 'вода', 'другое'];

/**
 * POST /api/orders
 * Body: { room_number: string, service_type: string, details?: string }
 */
router.post('/api/orders', async (req, res) => {
    try {
        const { room_number, service_type, details } = req.body;

        // --- Валидация входных данных ---
        if (!room_number || typeof room_number !== 'string') {
            return res.status(400).json({
                success: false,
                error: 'Поле room_number обязательно и должно быть строкой.'
            });
        }

        if (!service_type || !ALLOWED_SERVICE_TYPES.includes(service_type)) {
            return res.status(400).json({
                success: false,
                error: `Поле service_type обязательно. Допустимые значения: ${ALLOWED_SERVICE_TYPES.join(', ')}.`
            });
        }

        // details опционален, но ограничим длину, чтобы не залить базу мусором
        const safeDetails = typeof details === 'string' ? details.slice(0, 1000) : null;

        // --- Запись заказа в БД ---
        const { data: order, error: insertError } = await supabase
            .from('orders')
            .insert({
                room_number: room_number.trim(),
                service_type,
                details: safeDetails,
                status: 'new'
            })
            .select()
            .single();

        if (insertError) {
            console.error('Ошибка вставки заказа:', insertError);
            return res.status(500).json({
                success: false,
                error: 'Не удалось сохранить заказ. Попробуйте еще раз.'
            });
        }

        // ------------------------------------------------------
        // Уведомление персонала в WhatsApp о новом заказе.
        // Обёрнуто отдельным try/catch: если отправка не удалась,
        // заказ всё равно остаётся сохранённым в БД, а гость
        // получает success — просто в логах будет видна ошибка.
        // ------------------------------------------------------
        try {
            await notifyAdminAboutOrder(order);
        } catch (notifyError) {
            console.error('Не удалось отправить уведомление в WhatsApp:', notifyError);
            // Заказ уже сохранен — гостю все равно возвращаем success
        }

        return res.status(201).json({
            success: true,
            order
        });

    } catch (err) {
        console.error('Непредвиденная ошибка в /api/orders:', err);
        return res.status(500).json({
            success: false,
            error: 'Внутренняя ошибка сервера.'
        });
    }
});

/**
 * (Дополнительно) GET /api/orders/:room_number
 * Полезно для персонала — посмотреть активные заказы по номеру.
 */
router.get('/api/orders/:room_number', async (req, res) => {
    const { room_number } = req.params;

    const { data: orders, error } = await supabase
        .from('orders')
        .select('*')
        .eq('room_number', room_number)
        .order('created_at', { ascending: false });

    if (error) {
        return res.status(500).json({ success: false, error: 'Ошибка получения заказов.' });
    }

    return res.status(200).json({ success: true, orders });
});

module.exports = router;

// ============================================================
// Подключение в основном файле приложения (app.js / server.js):
//
//   const express = require('express');
//   const ordersRouter = require('./orders_api');
//
//   const app = express();
//   app.use(express.json());
//   app.use(ordersRouter);
//
//   app.listen(3000, () => console.log('Server running on port 3000'));
// ============================================================