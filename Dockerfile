FROM node:20-alpine AS base

WORKDIR /app

# Install only production dependencies for smaller image size.
COPY package*.json ./
RUN npm ci --omit=dev

# Copy app source after dependencies for better build cache.
COPY . .

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["npm", "start"]
