const get = require('lodash/get')
const flatten = require('lodash/flatten')
const keyBy = require('lodash/keyBy')
const groupBy = require('lodash/groupBy')
const orderBy = require('lodash/orderBy')
const compose = require('lodash/fp/compose')
const fpMap = require('lodash/fp/map').convert({ 'cap': false })
const map = require('lodash/map')
const filter = require('lodash/fp/filter')
const uniqWith = require('lodash/fp/uniqWith')
const fpFlatten = require('lodash/fp/flatten')
const request = require('request-promise')
const { IncomingWebhook } = require('@slack/webhook')
const format = require('date-fns/format')
const addDays = require('date-fns/add_days')
const ruLocale = require('date-fns/locale/ru')

const logger = console

const apiUrl = `${process.env.HURMA_URI}/api/v1`
const apiCall = async ({ path, page = 1 }) => {
    const response = await request.get({
        url: `${apiUrl}/${path}`,
        headers: {
            token: process.env.HURMA_API_TOKEN,
        },
        qs: {
            per_page: 100,
            page,
        },
        json: true,
    })

    return get(response, 'result.data', [])
}

const getLeavesByTypeFn = departments => async type => {
    const responses = await Promise.all(departments.map(({ id }) => apiCall({ path: `departments/${id}/${type}` })))
    const responsesWithDepartments = responses.map((response, i) => response.map(leave => ({
        ...leave,
        department_name: get(departments[i], 'name'),
    })))
    return flatten(responsesWithDepartments)
}

const getEmployeeByIdFn = employees => {
    const employeesById = keyBy(employees, 'id')
    return id => employeesById[id]
}

/**
 *
 * @type {{VACATION: number, SICK_LEAVE: number, WORK_FROM_HOME: number}}
 */
const leaveTypes = {
    VACATION: 1,
    UNPAID_VACATION: 2,
    SICK_LEAVE: 3,
    BUSINESS_TRIP: 4,
    WORK_FROM_HOME: 5,
}

/**
 * @type {{[p: string]: string, [p: number]: string}}
 */
const leaveIcons = {
    [leaveTypes.VACATION]: ':palm_tree:',
    [leaveTypes.UNPAID_VACATION]: ':money_mouth_face:',
    [leaveTypes.SICK_LEAVE]: ':pill:',
    [leaveTypes.BUSINESS_TRIP]: ':airplane:',
    [leaveTypes.WORK_FROM_HOME]: ':eggplant:',
}

const getBirthdays = ({ employees, date }) => employees.filter(({ birth_date }) => birth_date && birth_date.slice(-5) === format(date, 'MM-DD'))

const getVacationFinishDate = ({ vacations, startDate }) => {
    vacations = vacations.filter(({ day }) => new Date(day) > startDate)
    let finishDate = startDate
    while(vacations.some(({ day }) => new Date(day).getTime() === addDays(finishDate, 1).getTime())) {
        finishDate = addDays(finishDate, 1)
    }

    return finishDate
}

const getPeopleFutureVacations = ({ vacations, startDate }) => {
    vacations = orderBy(vacations
      .filter(({ day }) => new Date(day) >= startDate)
      .map(({ day, ...props }) => ({ ...props, day, date: new Date(day) })), ['date'], ['asc'])

    const dateInWeek = addDays(startDate, 7);

    let vacationsInWeek = vacations.filter(({ date }) => date <= dateInWeek)

    if (vacationsInWeek.length === 0) {
        return null
    }

    if (vacationsInWeek.some(({ date }) => date.getTime() === startDate.getTime())) {
        startDate = getVacationFinishDate({ vacations, startDate })
        vacationsInWeek = vacationsInWeek.filter(({ date }) => date > startDate)
    }

    const peopleVacations = []

    while(vacationsInWeek.length !== 0) {
        startDate = vacationsInWeek[0].date
        const finishDate = getVacationFinishDate({ vacations, startDate })
        peopleVacations.push({
            startDate,
            finishDate,
        })
        vacationsInWeek = vacationsInWeek.filter(({ date }) => date > finishDate)
    }

    return peopleVacations
}

const getFutureVacations = ({ vacationsByPeople, startDate }) => {
    return compose(
      filter(({ startDate, finishDate }) => startDate && finishDate),
      fpFlatten,
      fpMap((vacations, peopleId) => (getPeopleFutureVacations({ vacations, startDate }) || []).map((vacation) => ({ ...vacation, peopleId })))
    )(vacationsByPeople)
}

const getTextDate = date => format(date, 'DD MMM YYYY', { locale: ruLocale })

const getDatesRangeText = ({ startDate, finishDate }) => startDate.getTime() === finishDate.getTime()
  ? getTextDate(startDate)
  : `с ${getTextDate(startDate)} по ${getTextDate(finishDate)}`

const start = async () => {
    const employees = await apiCall({ path: 'employees' })
    const getEmployeeById = getEmployeeByIdFn(employees)
    const departments = await apiCall({ path: 'departments' })

    const today = new Date()
    const date = format(today, 'YYYY-MM-DD')
    const dateForText = getTextDate(today)

    const leavesRaw = fpFlatten(await Promise.all(['business-trip', 'home-work', 'sick-leave', 'sick-leave-documented', 'unpaid-vacations', 'vacations'].map(type => getLeavesByTypeFn(departments)(type))))
    const vacations = groupBy(leavesRaw, 'type_id')[leaveTypes.VACATION]
    const vacationsByPeople = groupBy(vacations, 'people_id')

    const prepare = compose(
      fpMap((leave) => ({
          ...leave,
          type_description: `${leave.type_description} ${leaveIcons[leave.type_id] || ''}`,
          ...leave.type_id === leaveTypes.VACATION && { finishAt: getVacationFinishDate({  startDate: date, vacations: vacationsByPeople[leave.people_id] }) }
      })),
      uniqWith((a, b) => a.people_id === b.people_id && a.type_id === b.type_id),
      filter(['day', date]),
    )

    const leaves = prepare(leavesRaw)

    const leavesText = leaves.map(({ people_id, department_name, type_description, finishAt }) => `${get(getEmployeeById(people_id), 'name')}, ${department_name}, ${get(getEmployeeById(people_id), 'position')}, ${type_description}${finishAt ? ` до ${getTextDate(finishAt)}` : ''}`)
      .join('\n')

    let text = leaves.length === 0
        ? `Все в офисе сегодня, *${dateForText}* :muscle:`
        : `Вне офиса сегодня, *${dateForText}*:\n\n${leavesText}`

    const birthdays = getBirthdays({ employees, date: today })
    const birthdayText = birthdays.length === 0 ? '' : `С Днем рождения, *${map(birthdays, 'name').join(', *')}*! :birthday::tada: Ждем пиццу на кухне! :pizza:`

    const futureVacations = getFutureVacations({ vacationsByPeople, startDate: today })

    text = futureVacations.length > 0 ? `${text}\n\nБлижайшие отпуска :palm_tree::\n\n${futureVacations.map(({ startDate, finishDate, peopleId }) => `${get(getEmployeeById(peopleId), 'name')}, ${getDatesRangeText({ startDate, finishDate})}`).join('\n')}` : text

    text = birthdayText ? `${text}\n\n${birthdayText}` : text
    logger.info(text)

    const webhook = new IncomingWebhook(process.env.SLACK_WEBHOOK_URL);
    await webhook.send({ text })
}

process.on('unhandledRejection', (reason, p) => {
    logger.info(`Possibly Unhandled Rejection at: Promise ${p}, reason: ${reason}`)
    process.exit(1)
})

start()
    .then(() => {
        logger.info('Successfully finished')
    })
    .catch(e => {
        logger.error(e)
        process.exit(1)
    })
