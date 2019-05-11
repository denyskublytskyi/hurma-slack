require('dotenv-safe').config({
    allowEmptyValues: true
});

const get = require('lodash/get')
const flatten = require('lodash/flatten')
const keyBy = require('lodash/keyBy')
const request = require('request-promise')
const { IncomingWebhook } = require('@slack/webhook')
const format = require('date-fns/format')
const ruLocale = require('date-fns/locale/ru')

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

const start = async () => {

    const employees = await apiCall({ path: 'employees' })
    const getEmployeeById = getEmployeeByIdFn(employees)
    const departments = await apiCall({ path: 'departments' })

    const getLeavesByType = getLeavesByTypeFn(departments)

    const businessTrips = await getLeavesByType('business-trip')
    const homeWorks = await getLeavesByType('home-works')
    const sickLeaves = await getLeavesByType('sick-leave')
    const sickLeavesDocumented = await getLeavesByType('sick-leave-documented')
    const unpaidVacations = await getLeavesByType('unpaid-vacations')
    const vacations = await getLeavesByType('vacations')

    const today = new Date()
    const date = format(today, 'YYYY-MM-DD')
    const dateForText = format(today, 'DD MMM YYYY', { locale: ruLocale })

    const leaves = [...businessTrips, ...homeWorks, ...sickLeaves, ...sickLeavesDocumented, ...unpaidVacations, ...vacations].filter(({ day }) => day === date)
    const leavesText = leaves.map(({ people_id, department_name, type_description }) => `${get(getEmployeeById(people_id), 'name')}, ${department_name}, ${get(getEmployeeById(people_id), 'position')}, ${type_description}`).join('\n')

    const text = leaves.length === 0
        ? `Все в офисе сегодня, *${dateForText}* :muscle:`
        :`Вне офиса сегодня, *${dateForText}*:\n\n${leavesText}`

    const webhook = new IncomingWebhook(process.env.SLACK_WEBHOOK_URL);
    await webhook.send({ text })
}

start()
