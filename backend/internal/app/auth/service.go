package auth

import (
	"context"
	"errors"
	"log/slog"

	"golang.org/x/crypto/bcrypt"

	corauth "github.com/DouDOU-start/airgate-core/internal/auth"
	sdk "github.com/DouDOU-start/airgate-sdk/sdkgo"
)

// Service 提供认证域用例编排。
type Service struct {
	repo   Repository
	jwtMgr *corauth.JWTManager
}

// NewService 创建认证服务。
func NewService(repo Repository, jwtMgr *corauth.JWTManager) *Service {
	return &Service{
		repo:   repo,
		jwtMgr: jwtMgr,
	}
}

// Login 用户登录。
func (s *Service) Login(ctx context.Context, input LoginInput) (LoginResult, error) {
	logger := sdk.LoggerFromContext(ctx)

	user, err := s.repo.FindByEmail(ctx, input.Email)
	if err != nil {
		if IsUserMissing(err) {
			logger.Warn("user_login_rejected", sdk.LogFieldReason, "user_not_found")
		} else {
			logger.Error("user_lookup_failed", sdk.LogFieldError, err)
		}
		return LoginResult{}, ErrInvalidCredentials
	}

	if user.Status != "active" {
		logger.Warn("user_login_rejected", sdk.LogFieldReason, "user_disabled", sdk.LogFieldUserID, user.ID)
		return LoginResult{}, ErrUserDisabled
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(input.Password)); err != nil {
		logger.Warn("user_login_rejected", sdk.LogFieldReason, "password_mismatch", sdk.LogFieldUserID, user.ID)
		return LoginResult{}, ErrInvalidCredentials
	}

	token, err := s.jwtMgr.GenerateToken(user.ID, user.Role, user.Email)
	if err != nil {
		logger.Error("jwt_issue_failed", sdk.LogFieldUserID, user.ID, sdk.LogFieldError, err)
		return LoginResult{}, err
	}

	logger.Info("user_login_succeeded", sdk.LogFieldUserID, user.ID)

	return LoginResult{
		Token: token,
		User:  user,
	}, nil
}

// Register 用户注册。
func (s *Service) Register(ctx context.Context, input RegisterInput) (LoginResult, error) {
	logger := sdk.LoggerFromContext(ctx)

	exists, err := s.repo.EmailExists(ctx, input.Email)
	if err != nil {
		logger.Error("user_lookup_failed", sdk.LogFieldError, err)
		return LoginResult{}, err
	}
	if exists {
		logger.Warn("user_register_rejected", sdk.LogFieldReason, "email_already_exists")
		return LoginResult{}, ErrEmailAlreadyExists
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(input.Password), bcrypt.DefaultCost)
	if err != nil {
		logger.Error("user_register_failed", sdk.LogFieldReason, "password_hash", sdk.LogFieldError, err)
		return LoginResult{}, err
	}

	user, err := s.repo.Create(ctx, CreateUserInput{
		Email:          input.Email,
		PasswordHash:   string(hash),
		Username:       input.Username,
		Role:           "user",
		Status:         "active",
		Balance:        input.Balance,
		MaxConcurrency: input.MaxConcurrency,
	})
	if err != nil {
		logger.Error("user_register_failed", sdk.LogFieldReason, "create_user", sdk.LogFieldError, err)
		return LoginResult{}, err
	}

	token, err := s.jwtMgr.GenerateToken(user.ID, user.Role, user.Email)
	if err != nil {
		logger.Error("jwt_issue_failed", sdk.LogFieldUserID, user.ID, sdk.LogFieldError, err)
		return LoginResult{}, err
	}

	logger.Info("user_register_succeeded", sdk.LogFieldUserID, user.ID)

	return LoginResult{
		Token: token,
		User:  user,
	}, nil
}

// FindByID 根据 ID 查询用户。
func (s *Service) FindByID(ctx context.Context, id int) (User, error) {
	return s.repo.FindByID(ctx, id, true)
}

// EmailExists 检查邮箱是否已注册。
func (s *Service) EmailExists(ctx context.Context, email string) (bool, error) {
	return s.repo.EmailExists(ctx, email)
}

// RefreshToken 刷新 JWT。
func (s *Service) RefreshToken(ctx context.Context, identity AuthIdentity) (string, error) {
	if identity.APIKeyID > 0 {
		user, err := s.repo.ValidateAPIKeySession(ctx, identity.UserID, identity.APIKeyID)
		if err != nil {
			slog.Default().Warn("api_key_session_refresh_rejected",
				sdk.LogFieldUserID, identity.UserID,
				sdk.LogFieldAPIKeyID, identity.APIKeyID,
				sdk.LogFieldError, err,
			)
			return "", err
		}
		token, err := s.jwtMgr.GenerateAPIKeyToken(user.ID, corauth.APIKeySessionRole, user.Email, identity.APIKeyID)
		if err != nil {
			slog.Default().Error("jwt_issue_failed",
				sdk.LogFieldUserID, identity.UserID,
				sdk.LogFieldAPIKeyID, identity.APIKeyID,
				sdk.LogFieldError, err,
			)
		}
		return token, err
	}
	token, err := s.jwtMgr.GenerateToken(identity.UserID, identity.Role, identity.Email)
	if err != nil {
		slog.Default().Error("jwt_issue_failed",
			sdk.LogFieldUserID, identity.UserID,
			sdk.LogFieldError, err,
		)
	}
	return token, err
}

// IsUserMissing 判断错误是否为用户不存在。
func IsUserMissing(err error) bool {
	return errors.Is(err, ErrUserNotFound)
}
