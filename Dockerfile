FROM node:12-alpine

EXPOSE 5000
WORKDIR /usr/src/app

COPY package*.json ./
COPY index.js ./
COPY .env.example ./

RUN npm i -q
CMD npm start
