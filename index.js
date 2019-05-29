require('dotenv-safe').config({
    allowEmptyValues: true
});


const get = require('lodash/get')
const flatten = require('lodash/flatten')
const keyBy = require('lodash/keyBy')
const compose = require('lodash/fp/compose')
const map = require('lodash/fp/map')
const filter = require('lodash/fp/filter')
const uniqWith = require('lodash/fp/uniqWith')
const fpFlatten = require('lodash/fp/flatten')
const request = require('request-promise')
const { IncomingWebhook } = require('@slack/webhook')
const format = require('date-fns/format')
const ruLocale = require('date-fns/locale/ru')

const logger = console

const apiUrl = `${process.env.HURMA_URI}/api/v1`
const apiCall = async ({ path }) => {
    const response = await request.get({
        url: `${apiUrl}/${path}`,
        headers: {
            token: process.env.HURMA_API_TOKEN,
        },
        qs: {
            per_page: 100,
        },
        json: true,
    })

    return get(response, 'result.data', [])
}

const getLeavesByTypeFn = departments => async type => {
    const responses = await Promise.all(departments.map(({ id }) => apiCall({ path: `departments/${id}/${type}` })));
    const responsesWithDepartments = responses.map((response, i) => response.map(leave => ({ ...leave, department_name: get(departments[i], 'name')})))
    return flatten(responsesWithDepartments)
}

const getEmployeeByIdFn = employees => {
    const employeesById = keyBy(employees, 'id')
    return id => employeesById[id]
}

const leaveTypes = {
    VACATION: 1,
    SICK_LEAVE: 3,
    WORK_FROM_HOME: 5,
}

const leaveIcons = {
    [leaveTypes.VACATION]: ':palm_tree:',
    [leaveTypes.SICK_LEAVE]: ':pill:',
    [leaveTypes.WORK_FROM_HOME]: ':eggplant:',
}

const start = async () => {

    const employees = await apiCall({ path: 'employees' })
    const getEmployeeById = getEmployeeByIdFn(employees)
    const departments = await apiCall({ path: 'departments' })

    const today = new Date()
    const date = format(today, 'YYYY-MM-DD')
    const dateForText = format(today, 'DD MMM YYYY', { locale: ruLocale })

    const prepare = compose(
        map((leave) => ({
            ...leave,
            type_description: `${leave.type_description} ${leaveIcons[leave.type_id] || ''}`
        })),
        uniqWith((a, b) => a.people_id === b.people_id && a.type_id === b.type_id),
        filter(['day', date]),
        fpFlatten,
    )

    const leaves = prepare(await Promise.all(['business-trip', 'home-work', 'sick-leave', 'sick-leave-documented', 'unpaid-vacations', 'vacations'].map(type => getLeavesByTypeFn(departments)(type))))

    const leavesText = leaves.map(({ people_id, department_name, type_description }) => `${get(getEmployeeById(people_id), 'name')}, ${department_name}, ${get(getEmployeeById(people_id), 'position')}, ${type_description}`).join('\n')

    const text = leaves.length === 0
        ? `Все в офисе сегодня, *${dateForText}* :muscle:`
        :`Вне офиса сегодня, *${dateForText}*:\n\n${leavesText}`

    logger.info(text)
    const webhook = new IncomingWebhook(process.env.SLACK_WEBHOOK_URL);
    await webhook.send({ text })
}

process.on('unhandledRejection', (reason, p) => {
    logger.info(`Possibly Unhandled Rejection at: Promise ${p}, reason: ${reason}`)
    process.exit(1)
})

start()
