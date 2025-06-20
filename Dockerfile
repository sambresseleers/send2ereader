# Use a Node.js base image
FROM node:18-alpine

# Set working directory
WORKDIR /usr/src/app

# Install dependencies for kepubify, kindlegen, and pdfCropMargins
# pdfCropMargins requires python and pip
RUN apk add --no-cache python3 py3-pip wget tar

# Install Kepubify
# Using the latest stable release URL to avoid 404 errors.
RUN wget https://github.com/pgaskin/kepubify/releases/download/v4.0.4/kepubify-linux-64bit -O /usr/local/bin/kepubify && \
    chmod +x /usr/local/bin/kepubify

# Install KindleGen
# The original Amazon and Internet Archive links are dead. Using a public mirror.
RUN wget https://github.com/ssut/kindlegen/releases/download/v2.9/kindlegen_linux_2.6_i386_v2_9.tar.gz -O kindlegen.tar.gz && \
    tar -xzf kindlegen.tar.gz && \
    mv kindlegen /usr/local/bin/kindlegen && \
    rm kindlegen.tar.gz

# Install pdfCropMargins
RUN pip3 install --no-cache-dir pdfCropMargins

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm install

# Copy the rest of your application's source code
COPY . .

# Expose the port the app runs on
EXPOSE 3001

# Command to run the application
CMD [ "npm", "start" ]
